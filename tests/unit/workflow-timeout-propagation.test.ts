import { projectWorkflowToGraph } from '../../src/state-machine/workflow-projection';
import { WorkflowDefinition } from '../../src/types/workflow';

describe('workflow timeout propagation', () => {
  it('should propagate parent timeout to nested steps without their own timeout', () => {
    const workflow: WorkflowDefinition = {
      id: 'assistant',
      name: 'Assistant',
      steps: {
        'intent-router': {
          type: 'ai',
          prompt: 'Classify intent',
        },
        'generate-response': {
          type: 'ai',
          prompt: 'Generate response',
          depends_on: ['intent-router'],
        },
        'step-with-timeout': {
          type: 'ai',
          prompt: 'Has own timeout',
          timeout: 60000,
          depends_on: ['intent-router'],
        },
      },
    };

    const parentTimeout = 120000; // 2 minutes
    const { config: workflowConfig } = projectWorkflowToGraph(workflow, {}, 'chat');

    // Simulate what workflow-check-provider does: propagate parent timeout
    if (workflowConfig.checks) {
      for (const stepCfg of Object.values(workflowConfig.checks) as any[]) {
        if (!stepCfg.timeout && !stepCfg.ai?.timeout) {
          stepCfg.timeout = parentTimeout;
        }
      }
    }

    // Steps without their own timeout should inherit parent's timeout
    expect((workflowConfig.checks as any)['intent-router'].timeout).toBe(120000);
    expect((workflowConfig.checks as any)['generate-response'].timeout).toBe(120000);

    // Steps with their own timeout should keep it
    expect((workflowConfig.checks as any)['step-with-timeout'].timeout).toBe(60000);
  });

  it('should not modify steps when parent has no timeout', () => {
    const workflow: WorkflowDefinition = {
      id: 'assistant',
      name: 'Assistant',
      steps: {
        'step-1': {
          type: 'ai',
          prompt: 'Do something',
        },
      },
    };

    const { config: workflowConfig } = projectWorkflowToGraph(workflow, {}, 'chat');

    // No parent timeout, so steps should not have timeout set
    expect((workflowConfig.checks as any)['step-1'].timeout).toBeUndefined();
  });
});
