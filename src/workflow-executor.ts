/**
 * Workflow executor for running workflow definitions
 */

import {
  WorkflowDefinition,
  WorkflowExecutionContext,
  WorkflowStep,
  WorkflowInputMapping,
  WorkflowExecutionOptions,
} from './types/workflow';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
import { CheckProviderRegistry } from './providers/check-provider-registry';
import { CheckProviderConfig, ExecutionContext } from './providers/check-provider.interface';
import { DependencyResolver } from './dependency-resolver';
import { logger } from './logger';
import { createSecureSandbox, compileAndRun } from './utils/sandbox';
// eslint-disable-next-line no-restricted-imports -- needed for Liquid type
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from './liquid-extensions';

/**
 * Workflow execution result
 */
export interface WorkflowExecutionResult {
  success: boolean;
  score?: number;
  confidence?: 'high' | 'medium' | 'low';
  issues?: any[];
  comments?: any[];
  output?: Record<string, unknown>;
  status: 'completed' | 'failed' | 'skipped';
  duration?: number;
  error?: string;
  stepSummaries?: Array<{
    stepId: string;
    status: 'success' | 'failed' | 'skipped';
    issues?: any[];
    output?: unknown;
  }>;
}

/**
 * Execution options passed to workflow executor
 */
interface WorkflowRunOptions {
  prInfo: PRInfo;
  dependencyResults?: Map<string, ReviewSummary>;
  context?: ExecutionContext;
  options?: WorkflowExecutionOptions;
}

/**
 * Executes workflow definitions
 */
export class WorkflowExecutor {
  private providerRegistry: CheckProviderRegistry | null = null;
  private liquid: Liquid;

  constructor() {
    // Don't call CheckProviderRegistry.getInstance() here to avoid circular dependency
    // during registry initialization (since WorkflowCheckProvider is registered in the registry)
    this.liquid = createExtendedLiquid();
  }

  /**
   * Lazy-load the provider registry to avoid circular dependency during initialization
   */
  private getProviderRegistry(): CheckProviderRegistry {
    if (!this.providerRegistry) {
      this.providerRegistry = CheckProviderRegistry.getInstance();
    }
    return this.providerRegistry;
  }

  /**
   * Execute a workflow
   */
  public async execute(
    workflow: WorkflowDefinition,
    executionContext: WorkflowExecutionContext,
    runOptions: WorkflowRunOptions
  ): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    executionContext.metadata = {
      startTime,
      status: 'running',
    };

    try {
      // Resolve step execution order
      const executionOrder = this.resolveExecutionOrder(workflow);
      logger.debug(`Workflow ${workflow.id} execution order: ${executionOrder.join(' -> ')}`);

      // Execute steps in order
      const stepResults = new Map<string, ReviewSummary>();
      const stepSummaries: Array<{
        stepId: string;
        status: 'success' | 'failed' | 'skipped';
        issues?: any[];
        output?: unknown;
      }> = [];

      for (const stepId of executionOrder) {
        const step = workflow.steps[stepId];

        // Check if step should be executed (evaluate 'if' condition)
        if (step.if) {
          const shouldRun = this.evaluateCondition(step.if, {
            inputs: executionContext.inputs,
            outputs: Object.fromEntries(stepResults),
            pr: runOptions.prInfo,
          });

          if (!shouldRun) {
            logger.info(`Skipping step '${stepId}' due to condition: ${step.if}`);
            stepSummaries.push({
              stepId,
              status: 'skipped',
            });
            continue;
          }
        }

        // Prepare step configuration
        const stepConfig = await this.prepareStepConfig(
          step,
          stepId,
          executionContext,
          stepResults,
          workflow
        );

        // Execute the step
        try {
          logger.info(`Executing workflow step '${stepId}'`);
          // Extend context with workflow inputs
          const stepContext: ExecutionContext = {
            ...runOptions.context,
            workflowInputs: executionContext.inputs,
          };
          const result = await this.executeStep(
            stepConfig,
            runOptions.prInfo,
            stepResults,
            stepContext
          );

          stepResults.set(stepId, result);
          stepSummaries.push({
            stepId,
            status: 'success',
            issues: result.issues,
            output: (result as any).output,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Step '${stepId}' failed: ${errorMessage}`);

          stepSummaries.push({
            stepId,
            status: 'failed',
            output: { error: errorMessage },
          });

          if (!runOptions.options?.continueOnError) {
            throw new Error(`Workflow step '${stepId}' failed: ${errorMessage}`);
          }
        }
      }

      // Compute workflow outputs
      const outputs = await this.computeOutputs(
        workflow,
        executionContext,
        stepResults,
        runOptions.prInfo
      );
      executionContext.outputs = outputs;

      // Aggregate results
      const aggregated = this.aggregateResults(stepResults);

      const endTime = Date.now();
      executionContext.metadata.endTime = endTime;
      executionContext.metadata.duration = endTime - startTime;
      executionContext.metadata.status = 'completed';

      return {
        success: true,
        score: aggregated.score,
        confidence: aggregated.confidence,
        issues: aggregated.issues,
        comments: aggregated.comments,
        output: outputs,
        status: 'completed',
        duration: endTime - startTime,
        stepSummaries,
      };
    } catch (error) {
      const endTime = Date.now();
      executionContext.metadata.endTime = endTime;
      executionContext.metadata.duration = endTime - startTime;
      executionContext.metadata.status = 'failed';
      executionContext.metadata.error = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        status: 'failed',
        duration: endTime - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Resolve step execution order based on dependencies
   */
  private resolveExecutionOrder(workflow: WorkflowDefinition): string[] {
    // Build dependency map
    const dependencies: Record<string, string[]> = {};
    for (const [stepId, step] of Object.entries(workflow.steps)) {
      // Normalize depends_on to array (supports string | string[])
      const rawDeps = step.depends_on;
      dependencies[stepId] = Array.isArray(rawDeps) ? rawDeps : rawDeps ? [rawDeps] : [];
    }

    // Use static DependencyResolver
    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    if (graph.hasCycles) {
      throw new Error(
        `Circular dependency detected in workflow steps: ${graph.cycleNodes?.join(' -> ')}`
      );
    }

    // Flatten execution groups to get linear order
    const order: string[] = [];
    for (const group of graph.executionOrder) {
      order.push(...group.parallel);
    }

    return order;
  }

  /**
   * Prepare step configuration with input mappings
   */
  private async prepareStepConfig(
    step: WorkflowStep,
    stepId: string,
    executionContext: WorkflowExecutionContext,
    stepResults: Map<string, ReviewSummary>,
    workflow: WorkflowDefinition
  ): Promise<CheckProviderConfig> {
    const config: CheckProviderConfig = {
      ...step,
      type: step.type || 'ai',
      checkName: `${executionContext.instanceId}:${stepId}`,
    };

    // Process input mappings
    if (step.inputs) {
      for (const [inputName, mapping] of Object.entries(step.inputs)) {
        const value = await this.resolveInputMapping(
          mapping,
          executionContext,
          stepResults,
          workflow
        );
        (config as any)[inputName] = value;
      }
    }

    return config;
  }

  /**
   * Resolve input mapping to actual value
   */
  private async resolveInputMapping(
    mapping: string | WorkflowInputMapping,
    executionContext: WorkflowExecutionContext,
    stepResults: Map<string, ReviewSummary>,
    _workflow: WorkflowDefinition
  ): Promise<unknown> {
    // Simple string mapping - treat as parameter reference
    if (typeof mapping === 'string') {
      return executionContext.inputs[mapping];
    }

    // Complex mapping
    if (typeof mapping === 'object' && mapping !== null && 'source' in mapping) {
      const typedMapping = mapping as WorkflowInputMapping;

      switch (typedMapping.source) {
        case 'param':
          // Reference to workflow input parameter
          return executionContext.inputs[String(typedMapping.value)];

        case 'step':
          // Reference to another step's output
          if (!typedMapping.stepId) {
            throw new Error('Step input mapping requires stepId');
          }
          const stepResult = stepResults.get(typedMapping.stepId);
          if (!stepResult) {
            throw new Error(`Step '${typedMapping.stepId}' has not been executed yet`);
          }
          const output = (stepResult as any).output;
          if (typedMapping.outputParam && output) {
            return output[typedMapping.outputParam];
          }
          return output;

        case 'constant':
          // Constant value
          return typedMapping.value;

        case 'expression':
          // JavaScript expression
          if (!typedMapping.expression) {
            throw new Error('Expression mapping requires expression field');
          }
          const sandbox = createSecureSandbox();
          return compileAndRun(
            sandbox,
            typedMapping.expression,
            {
              inputs: executionContext.inputs,
              outputs: Object.fromEntries(stepResults),
              steps: Object.fromEntries(
                Array.from(stepResults.entries()).map(([id, result]) => [
                  id,
                  (result as any).output,
                ])
              ),
            },
            { injectLog: true, logPrefix: 'workflow.input.expression' }
          );

        default:
          throw new Error(`Unknown input mapping source: ${typedMapping.source}`);
      }
    }

    // Handle Liquid template in mapping
    if (typeof mapping === 'object' && mapping !== null && 'template' in mapping) {
      const typedMapping = mapping as WorkflowInputMapping;
      if (typedMapping.template) {
        return await this.liquid.parseAndRender(typedMapping.template, {
          inputs: executionContext.inputs,
          outputs: Object.fromEntries(stepResults),
        });
      }
    }

    // Return as-is
    return mapping;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    config: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const provider = await this.getProviderRegistry().getProvider(config.type);
    if (!provider) {
      throw new Error(`Provider '${config.type}' not found`);
    }

    return await provider.execute(prInfo, config, dependencyResults, context);
  }

  /**
   * Compute workflow outputs
   */
  private async computeOutputs(
    workflow: WorkflowDefinition,
    executionContext: WorkflowExecutionContext,
    stepResults: Map<string, ReviewSummary>,
    prInfo: PRInfo
  ): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = {};

    if (!workflow.outputs) {
      return outputs;
    }

    for (const output of workflow.outputs) {
      if (output.value_js) {
        // JavaScript expression
        const sandbox = createSecureSandbox();
        outputs[output.name] = compileAndRun(
          sandbox,
          output.value_js,
          {
            inputs: executionContext.inputs,
            steps: Object.fromEntries(
              Array.from(stepResults.entries()).map(([id, result]) => [id, (result as any).output])
            ),
            outputs: Object.fromEntries(stepResults),
            pr: prInfo,
          },
          { injectLog: true, logPrefix: `workflow.output.${output.name}` }
        );
      } else if (output.value) {
        // Liquid template
        outputs[output.name] = await this.liquid.parseAndRender(output.value, {
          inputs: executionContext.inputs,
          steps: Object.fromEntries(
            Array.from(stepResults.entries()).map(([id, result]) => [id, (result as any).output])
          ),
          outputs: Object.fromEntries(stepResults),
          pr: prInfo,
        });
      }
    }

    return outputs;
  }

  /**
   * Aggregate results from all steps
   */
  private aggregateResults(stepResults: Map<string, ReviewSummary>): {
    score: number;
    confidence: 'high' | 'medium' | 'low';
    issues: any[];
    comments: any[];
  } {
    let totalScore = 0;
    let scoreCount = 0;
    const allIssues: any[] = [];
    const allComments: any[] = [];
    let minConfidence: 'high' | 'medium' | 'low' = 'high';

    for (const result of stepResults.values()) {
      const extResult = result as any;
      if (typeof extResult.score === 'number') {
        totalScore += extResult.score;
        scoreCount++;
      }

      if (result.issues) {
        allIssues.push(...result.issues);
      }

      if (extResult.comments) {
        allComments.push(...extResult.comments);
      }

      if (extResult.confidence) {
        if (
          extResult.confidence === 'low' ||
          (extResult.confidence === 'medium' && minConfidence === 'high')
        ) {
          minConfidence = extResult.confidence;
        }
      }
    }

    return {
      score: scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0,
      confidence: minConfidence,
      issues: allIssues,
      comments: allComments,
    };
  }

  /**
   * Evaluate a condition expression
   */
  private evaluateCondition(condition: string, context: any): boolean {
    try {
      const sandbox = createSecureSandbox();
      const result = compileAndRun(sandbox, condition, context, {
        injectLog: true,
        logPrefix: 'workflow.condition',
      });
      return Boolean(result);
    } catch (error) {
      logger.warn(`Failed to evaluate condition '${condition}': ${error}`);
      return false;
    }
  }
}
