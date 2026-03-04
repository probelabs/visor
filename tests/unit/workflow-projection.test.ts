import { projectWorkflowToGraph } from '../../src/state-machine/workflow-projection';
import { WorkflowDefinition } from '../../src/types/workflow';

describe('projectWorkflowToGraph', () => {
  it('should project sandbox fields from workflow to config', () => {
    const workflow: WorkflowDefinition = {
      id: 'test-workflow',
      name: 'Test Workflow',
      sandboxes: {
        'bwrap-env': {
          engine: 'bubblewrap',
          bind_paths: [{ host: '~/.gitconfig' }],
          workdir: 'host',
        },
      },
      sandbox: 'bwrap-env',
      sandbox_defaults: {
        env_passthrough: ['HOME', 'PATH'],
      },
      steps: {
        'step-1': {
          type: 'command',
          exec: 'echo hello',
        },
      },
    };

    const { config } = projectWorkflowToGraph(workflow, {}, 'parent-check');

    expect(config.sandboxes).toBeDefined();
    expect(config.sandboxes!['bwrap-env'].engine).toBe('bubblewrap');
    expect(config.sandboxes!['bwrap-env'].bind_paths).toHaveLength(1);
    expect(config.sandboxes!['bwrap-env'].workdir).toBe('host');
    expect(config.sandbox).toBe('bwrap-env');
    expect(config.sandbox_defaults).toEqual({
      env_passthrough: ['HOME', 'PATH'],
    });
  });

  it('should not include sandbox fields when not specified in workflow', () => {
    const workflow: WorkflowDefinition = {
      id: 'no-sandbox-workflow',
      name: 'No Sandbox Workflow',
      steps: {
        'step-1': {
          type: 'command',
          exec: 'echo hello',
        },
      },
    };

    const { config } = projectWorkflowToGraph(workflow, {}, 'parent-check');

    expect(config.sandboxes).toBeUndefined();
    expect(config.sandbox).toBeUndefined();
    expect(config.sandbox_defaults).toBeUndefined();
  });

  it('should throw when workflow has no steps', () => {
    const workflow: WorkflowDefinition = {
      id: 'empty-workflow',
      name: 'Empty',
      steps: {},
    };

    expect(() => projectWorkflowToGraph(workflow, {}, 'parent')).toThrow('has no steps');
  });
});
