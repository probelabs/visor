# Isolated Workspace with Full Run Separation

## Goal

Provide **full isolation between parallel visor runs** with human-readable project names. Each run gets its own workspace in `/tmp` containing worktrees for all projects, ensuring no interference between concurrent executions.

## Proposed Structure

```
/tmp/visor-workspaces/<sessionId>/
├── visor2/        → worktree of main project (full isolated copy)
├── tyk-docs/      → worktree of tyk-docs repo (isolated)
├── tyk-gateway/   → worktree of tyk-gateway repo (isolated)
└── ...
```

**Key Design Decisions**:
- **Workspace ID**: Use `sessionId` (UUID from EngineContext)
- **Location**: `/tmp/visor-workspaces/` (configurable via `VISOR_WORKSPACE_PATH` env var)
- **Main project**: Worktree created automatically on run start (not symlink - full isolation)
- **Checkout projects**: Worktrees with human-readable names (repo name extracted from `owner/repo`)
- **workingDirectory**: All steps use workspace path as their working directory

## Why /tmp Instead of .visor/?

Git doesn't allow worktrees inside the same repository tree. Since `.visor/` is inside the project, we can't create a worktree of the main project there. Using `/tmp` (external path) solves this:
- Worktrees can be created for any repo including the main project
- Full isolation - each run has its own copy of everything
- Clean separation from the project directory

## Implementation Plan

### 1. Create WorkspaceManager class

**File**: `src/utils/workspace-manager.ts`

```typescript
export class WorkspaceManager {
  private sessionId: string;
  private basePath: string;       // /tmp/visor-workspaces
  private workspacePath: string;  // /tmp/visor-workspaces/<sessionId>
  private originalPath: string;   // Original cwd where visor was invoked

  // Singleton per session
  static getInstance(sessionId: string, originalPath: string, config?: WorkspaceConfig): WorkspaceManager

  // Initialize workspace and create main project worktree
  async initialize(): Promise<WorkspaceInfo>

  // Add a project (called by git-checkout, creates symlink to worktree)
  async addProject(projectName: string, worktreePath: string): Promise<string>

  // Get workspace path (for use as workingDirectory)
  getWorkspacePath(): string

  // Cleanup workspace on run end
  async cleanup(): Promise<void>
}
```

**Key behaviors**:
- `initialize()`:
  1. Creates `/tmp/visor-workspaces/<sessionId>/`
  2. Creates worktree of main project at `<workspace>/<project-name>/`
  3. Registers cleanup handlers
- `addProject()`: Creates symlink from human-readable name to actual worktree path
- `extractProjectName()`: Helper to get repo name from `owner/repo` format

### 2. Initialize workspace at engine startup

**File**: `src/state-machine/context/build-engine-context.ts`

At the start of `buildEngineContextForRun()`:
1. Create WorkspaceManager instance with `sessionId`
2. Initialize workspace (creates main project worktree)
3. Set `context.workingDirectory` to workspace path
4. Store original path in `context.originalWorkingDirectory`

```typescript
// In buildEngineContextForRun():
const workspace = WorkspaceManager.getInstance(sessionId, workingDirectory);
await workspace.initialize();

return {
  // ...
  workingDirectory: workspace.getWorkspacePath(),  // All steps use this
  originalWorkingDirectory: workingDirectory,       // For reference
  workspace,  // For git-checkout to add projects
};
```

### 3. Integrate git-checkout with workspace

**File**: `src/providers/git-checkout-provider.ts`

After creating worktree, add it to workspace:
```typescript
// After worktree creation:
const workspace = (context as any)?.workspace;
if (workspace?.isEnabled()) {
  const projectName = extractProjectName(resolvedRepository);
  const workspacePath = await workspace.addProject(projectName, worktree.path);
  output.workspace_path = workspacePath;
}
```

### 4. Update types

**File**: `src/types/git-checkout.ts`
```typescript
export interface GitCheckoutOutput {
  // ... existing fields ...
  workspace_path?: string;  // Path within workspace (human-readable)
}
```

**File**: `src/types/engine.ts` (or wherever EngineContext is defined)
```typescript
export interface EngineContext {
  // ... existing fields ...
  originalWorkingDirectory: string;  // Where visor was invoked
  workspace?: WorkspaceManager;      // Workspace manager instance
}
```

### 5. Handle duplicate project names

When multiple checkouts have the same repo name:
- First: `tyk-docs`
- Second: `tyk-docs-2`
- Or use `description` if provided

### 6. Cleanup integration

**Automatic cleanup on**:
- Normal run completion
- SIGINT/SIGTERM
- Uncaught exceptions

**Cleanup actions**:
1. Remove main project worktree via `git worktree remove`
2. Remove workspace directory
3. Note: git-checkout worktrees are managed separately by WorktreeManager

### 7. Configuration

```typescript
// Environment variable
VISOR_WORKSPACE_PATH=/custom/path  // Override base path
VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT=true  // Optional: expose main project to AI tools

// Future: config file option
workspace:
  enabled: true
  base_path: /tmp/visor-workspaces
  cleanup_on_exit: true
  include_main_project: false  # Optional: expose main project to AI tools
```

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/utils/workspace-manager.ts` | Create | WorkspaceManager class |
| `src/state-machine/context/build-engine-context.ts` | Modify | Initialize workspace, set workingDirectory |
| `src/providers/git-checkout-provider.ts` | Modify | Add projects to workspace |
| `src/types/git-checkout.ts` | Modify | Add `workspace_path` to output |
| `src/types/engine.ts` | Modify | Add workspace fields to EngineContext |
| `tests/unit/workspace-manager.test.ts` | Create | Unit tests |

## Example Flow

```
1. User runs: visor --check code-review
   └─ cwd: /home/user/my-project

2. Engine starts:
   └─ sessionId: abc-123-uuid
   └─ WorkspaceManager.initialize()
       └─ Creates: /tmp/visor-workspaces/abc-123-uuid/
       └─ Creates worktree: /tmp/visor-workspaces/abc-123-uuid/my-project/
   └─ workingDirectory = /tmp/visor-workspaces/abc-123-uuid/

3. git-checkout step runs:
   └─ Creates worktree in .visor/worktrees/worktrees/tyk-docs-main-xyz789
   └─ workspace.addProject("tyk-docs", worktreePath)
       └─ Creates symlink: /tmp/visor-workspaces/abc-123-uuid/tyk-docs/
   └─ Output: { path: ".visor/worktrees/...", workspace_path: "/tmp/.../tyk-docs" }

4. AI step runs:
   └─ workingDirectory = /tmp/visor-workspaces/abc-123-uuid/
   └─ Sees: my-project/, tyk-docs/
   └─ Can access all projects with human-readable names

5. Run completes:
   └─ workspace.cleanup()
       └─ Removes worktree: my-project/
       └─ Removes directory: /tmp/visor-workspaces/abc-123-uuid/
```

## Benefits

1. **Full isolation**: Parallel runs can't interfere (separate workspaces)
2. **Human-readable paths**: `tyk-docs/` instead of `tyk-tyk-docs-main-ab12cd34/`
3. **Unified workspace**: All projects for a run accessible from one directory
4. **Automatic workingDirectory**: All steps operate in isolated scope
5. **No git-in-git issues**: Workspace is in /tmp, outside any repository
6. **Clean cleanup**: Just remove the workspace directory

## Trade-offs

1. **Disk usage**: Each run creates a worktree of main project (uses git's efficient storage, but still some overhead)

2. **Startup time**: Small delay to create main project worktree

3. **Windows**: Git worktrees work on Windows, but paths might need adjustment

4. **Debugging**: Workspace is in /tmp - might be cleared on reboot. Consider `cleanup_on_exit: false` option for debugging.
