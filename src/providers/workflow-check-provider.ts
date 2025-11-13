/**
 * Workflow check provider - executes reusable workflows as checks
 */

import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { WorkflowRegistry } from '../workflow-registry';
import { WorkflowExecutor } from '../workflow-executor';
import { logger } from '../logger';
import { WorkflowDefinition, WorkflowExecutionContext } from '../types/workflow';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { Liquid } from 'liquidjs';

/**
 * Provider that executes workflows as checks
 */
export class WorkflowCheckProvider extends CheckProvider {
  private registry: WorkflowRegistry;
  private executor: WorkflowExecutor;
  private liquid: Liquid;

  constructor() {
    super();
    this.registry = WorkflowRegistry.getInstance();
    this.executor = new WorkflowExecutor();
    this.liquid = new Liquid();
  }

  getName(): string {
    return 'workflow';
  }

  getDescription(): string {
    return 'Executes reusable workflow definitions as checks';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    const cfg = config as CheckProviderConfig;

    if (!cfg.workflow) {
      logger.error('Workflow provider requires "workflow" field');
      return false;
    }

    // Check if workflow exists in registry
    if (!this.registry.has(cfg.workflow as string)) {
      logger.error(`Workflow '${cfg.workflow}' not found in registry`);
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const workflowId = config.workflow as string;

    // Get the workflow definition
    const workflow = this.registry.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow '${workflowId}' not found in registry`);
    }

    logger.info(`Executing workflow '${workflowId}'`);

    // Prepare inputs
    const inputs = await this.prepareInputs(workflow, config, prInfo, dependencyResults);

    // Validate inputs
    const validation = this.registry.validateInputs(workflow, inputs);
    if (!validation.valid) {
      const errors = validation.errors?.map((e) => `${e.path}: ${e.message}`).join(', ');
      throw new Error(`Invalid workflow inputs: ${errors}`);
    }

    // Apply overrides to workflow steps if specified
    const modifiedWorkflow = this.applyOverrides(workflow, config);

    // Execute the workflow
    const executionContext: WorkflowExecutionContext = {
      instanceId: `${workflowId}-${Date.now()}`,
      parentCheckId: config.checkName,
      inputs,
      stepResults: new Map(),
    };

    const result = await this.executor.execute(modifiedWorkflow, executionContext, {
      prInfo,
      dependencyResults,
      context,
    });

    // Map outputs
    const outputs = this.mapOutputs(result, config.output_mapping as Record<string, string>);

    // Return the review summary with extended fields
    // Note: These extra fields are used by the execution engine but not part of the base interface
    const summary: ReviewSummary = {
      issues: result.issues || [],
    };

    // Add extended fields as needed by the engine
    (summary as any).score = result.score || 0;
    (summary as any).confidence = result.confidence || 'medium';
    (summary as any).comments = result.comments || [];
    (summary as any).output = outputs;
    (summary as any).content = this.formatWorkflowResult(workflow, result, outputs);

    return summary;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'workflow',
      'args',
      'overrides',
      'output_mapping',
      'timeout',
      'env',
      'checkName',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available
  }

  getRequirements(): string[] {
    return [];
  }

  /**
   * Prepare inputs for workflow execution
   */
  private async prepareInputs(
    workflow: WorkflowDefinition,
    config: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<Record<string, unknown>> {
    const inputs: Record<string, unknown> = {};

    // Start with default values from workflow definition
    if (workflow.inputs) {
      for (const param of workflow.inputs) {
        if (param.default !== undefined) {
          inputs[param.name] = param.default;
        }
      }
    }

    // Apply user-provided inputs (args)
    const userInputs = config.args || config.workflow_inputs; // Support both for compatibility
    if (userInputs) {
      for (const [key, value] of Object.entries(userInputs)) {
        // Process value if it's a template or expression
        if (typeof value === 'string') {
          // Check if it's a Liquid template
          if (value.includes('{{') || value.includes('{%')) {
            inputs[key] = await this.liquid.parseAndRender(value, {
              pr: prInfo,
              outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
              env: process.env,
            });
          } else {
            inputs[key] = value;
          }
        } else if (typeof value === 'object' && value !== null && 'expression' in value) {
          // JavaScript expression
          const exprValue = value as { expression: string };
          const sandbox = createSecureSandbox();
          inputs[key] = compileAndRun(
            sandbox,
            exprValue.expression,
            {
              pr: prInfo,
              outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
              env: process.env,
            },
            { injectLog: true, logPrefix: `workflow.input.${key}` }
          );
        } else {
          inputs[key] = value;
        }
      }
    }

    return inputs;
  }

  /**
   * Apply overrides to workflow steps
   */
  private applyOverrides(workflow: WorkflowDefinition, config: CheckProviderConfig): WorkflowDefinition {
    const overrideConfig = config.overrides || config.workflow_overrides; // Support both for compatibility
    if (!overrideConfig) {
      return workflow;
    }

    // Deep clone the workflow
    const modified = JSON.parse(JSON.stringify(workflow));

    // Apply overrides
    for (const [stepId, overrides] of Object.entries(overrideConfig)) {
      if (modified.steps[stepId]) {
        // Merge overrides with existing step config
        modified.steps[stepId] = {
          ...modified.steps[stepId],
          ...overrides,
        };
      } else {
        logger.warn(`Cannot override non-existent step '${stepId}' in workflow '${workflow.id}'`);
      }
    }

    return modified;
  }

  /**
   * Map workflow outputs to check outputs
   */
  private mapOutputs(result: any, outputMapping?: Record<string, string>): Record<string, unknown> {
    if (!outputMapping) {
      return result.output || {};
    }

    const mapped: Record<string, unknown> = {};
    const workflowOutputs = result.output || {};

    for (const [checkOutput, workflowOutput] of Object.entries(outputMapping)) {
      if (workflowOutput in workflowOutputs) {
        mapped[checkOutput] = workflowOutputs[workflowOutput];
      } else if (workflowOutput.includes('.')) {
        // Handle nested paths
        const parts = workflowOutput.split('.');
        let value = workflowOutputs;
        for (const part of parts) {
          value = value?.[part];
          if (value === undefined) break;
        }
        mapped[checkOutput] = value;
      }
    }

    return mapped;
  }

  /**
   * Format workflow execution result for display
   */
  private formatWorkflowResult(
    workflow: WorkflowDefinition,
    result: any,
    outputs: Record<string, unknown>
  ): string {
    const lines: string[] = [];

    lines.push(`Workflow: ${workflow.name}`);
    if (workflow.description) {
      lines.push(`Description: ${workflow.description}`);
    }

    lines.push('');
    lines.push('Execution Summary:');
    lines.push(`- Status: ${result.status || 'completed'}`);
    lines.push(`- Score: ${result.score || 0}`);
    lines.push(`- Issues Found: ${result.issues?.length || 0}`);

    if (result.duration) {
      lines.push(`- Duration: ${result.duration}ms`);
    }

    if (Object.keys(outputs).length > 0) {
      lines.push('');
      lines.push('Outputs:');
      for (const [key, value] of Object.entries(outputs)) {
        const formatted = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        lines.push(`- ${key}: ${formatted}`);
      }
    }

    if (result.stepSummaries && result.stepSummaries.length > 0) {
      lines.push('');
      lines.push('Step Results:');
      for (const summary of result.stepSummaries) {
        lines.push(`- ${summary.stepId}: ${summary.status} (${summary.issues?.length || 0} issues)`);
      }
    }

    return lines.join('\n');
  }
}