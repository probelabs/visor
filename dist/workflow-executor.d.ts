/**
 * Workflow executor for running workflow definitions
 */
import { WorkflowDefinition, WorkflowExecutionContext, WorkflowExecutionOptions } from './types/workflow';
import { PRInfo } from './pr-analyzer';
import { ReviewSummary } from './reviewer';
import { ExecutionContext } from './providers/check-provider.interface';
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
export declare class WorkflowExecutor {
    private providerRegistry;
    private liquid;
    constructor();
    /**
     * Lazy-load the provider registry to avoid circular dependency during initialization
     */
    private getProviderRegistry;
    /**
     * Execute a workflow
     */
    execute(workflow: WorkflowDefinition, executionContext: WorkflowExecutionContext, runOptions: WorkflowRunOptions): Promise<WorkflowExecutionResult>;
    /**
     * Resolve step execution order based on dependencies
     */
    private resolveExecutionOrder;
    /**
     * Prepare step configuration with input mappings
     */
    private prepareStepConfig;
    /**
     * Resolve input mapping to actual value
     */
    private resolveInputMapping;
    /**
     * Execute a single step
     */
    private executeStep;
    /**
     * Compute workflow outputs
     */
    private computeOutputs;
    /**
     * Aggregate results from all steps
     */
    private aggregateResults;
    /**
     * Evaluate a condition expression
     */
    private evaluateCondition;
}
export {};
