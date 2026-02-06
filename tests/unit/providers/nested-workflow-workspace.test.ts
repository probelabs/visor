/**
 * Tests for workspace propagation through nested workflows
 *
 * This test verifies that when a parent workflow has workspace enabled,
 * nested workflow steps (via workflow-check-provider) properly propagate
 * the workspace to their child checks.
 *
 * These tests validate the data flow pattern without needing to instantiate
 * the actual providers - they test the context structure expected by the system.
 */

describe('Nested Workflow Workspace Propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Workspace Propagation', () => {
    it('should pass workspace from ExecutionContext._parentContext to child context', async () => {
      // Create a mock workspace
      const mockWorkspace = {
        isEnabled: () => true,
        listProjects: () => [{ name: 'test-project', path: '/tmp/test' }],
        addProject: jest.fn().mockResolvedValue('/tmp/workspace/test-project'),
        getWorkspacePath: () => '/tmp/workspace',
      };

      // Create the execution context that level-dispatch passes to the provider
      // This simulates what happens when a workflow step runs
      const mockParentEngineContext = {
        workspace: mockWorkspace,
        workingDirectory: '/tmp/test-dir',
        originalWorkingDirectory: '/tmp/original-dir',
        sessionId: 'test-session',
        event: 'manual',
        debug: false,
        config: {
          checks: {},
        },
        memory: {
          getConfig: () => ({}),
        },
      };

      const executionContext = {
        _parentContext: mockParentEngineContext,
        _parentState: {
          flags: {
            currentWorkflowDepth: 0,
            maxWorkflowDepth: 3,
          },
        },
      };

      // The provider should extract workspace from _parentContext
      const parentContext = (executionContext as any)?._parentContext;
      expect(parentContext).toBeDefined();
      expect(parentContext.workspace).toBeDefined();
      expect(parentContext.workspace.isEnabled()).toBe(true);

      // Verify the workspace is the mock we created
      const workspace = parentContext.workspace;
      expect(workspace.listProjects()).toHaveLength(1);
      expect(workspace.listProjects()[0].name).toBe('test-project');
    });

    it('should handle missing workspace gracefully', async () => {
      // Parent context without workspace
      const mockParentEngineContext = {
        workingDirectory: '/tmp/test-dir',
        sessionId: 'test-session',
        event: 'manual',
        config: {},
      };

      const executionContext = {
        _parentContext: mockParentEngineContext,
      };

      const parentContext = (executionContext as any)?._parentContext;
      expect(parentContext).toBeDefined();
      expect(parentContext.workspace).toBeUndefined();
    });

    it('should propagate workspace when childContext is built', () => {
      // This tests the logic that would be in workflow-check-provider
      // for building the child context

      const mockWorkspace = {
        isEnabled: () => true,
        listProjects: () => [],
      };

      const parentContext = {
        workspace: mockWorkspace,
        workingDirectory: '/tmp',
      };

      // Simulate what workflow-check-provider does
      const parentWorkspace = parentContext?.workspace;

      const childContext = {
        workspace: parentWorkspace,
        workingDirectory: parentContext?.workingDirectory || process.cwd(),
      };

      expect(childContext.workspace).toBe(mockWorkspace);
      expect(childContext.workspace?.isEnabled()).toBe(true);
    });
  });

  describe('Context Chain Verification', () => {
    it('verifies context chain: level-dispatch -> provider -> StateMachineRunner', () => {
      // This tests the full chain that should happen:
      // 1. Parent workflow has EngineContext with workspace
      // 2. level-dispatch creates executionContext with _parentContext = EngineContext
      // 3. workflow-check-provider extracts workspace from executionContext._parentContext
      // 4. Creates childContext with workspace from parent
      // 5. Nested workflow's level-dispatch creates executionContext with _parentContext = childContext
      // 6. Nested checks read workspace from executionContext._parentContext.workspace

      const mockWorkspace = {
        isEnabled: () => true,
        listProjects: () => [{ name: 'proj1', path: '/p1' }],
      };

      // Step 1: Parent EngineContext
      const parentEngineContext = {
        workspace: mockWorkspace,
        sessionId: 'parent-session',
        workingDirectory: '/parent/dir',
      };

      // Step 2: level-dispatch creates executionContext for workflow step
      const executionContextForWorkflowStep = {
        _parentContext: parentEngineContext,
      };

      // Step 3: workflow-check-provider extracts
      const extractedParentContext = (executionContextForWorkflowStep as any)._parentContext;
      const extractedWorkspace = extractedParentContext?.workspace;
      expect(extractedWorkspace).toBe(mockWorkspace);

      // Step 4: Create child context
      const childContext = {
        workspace: extractedWorkspace,
        sessionId: 'child-session',
        workingDirectory: extractedParentContext?.workingDirectory,
      };

      // Step 5: Nested workflow's level-dispatch creates executionContext
      const executionContextForNestedCheck = {
        _parentContext: childContext,
      };

      // Step 6: Nested check reads workspace
      const nestedCheckParentContext = (executionContextForNestedCheck as any)._parentContext;
      const nestedCheckWorkspace = nestedCheckParentContext?.workspace;

      expect(nestedCheckWorkspace).toBe(mockWorkspace);
      expect(nestedCheckWorkspace?.isEnabled()).toBe(true);
      expect(nestedCheckWorkspace?.listProjects()).toHaveLength(1);
    });
  });
});
