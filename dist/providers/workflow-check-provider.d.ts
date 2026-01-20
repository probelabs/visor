/**
 * Workflow check provider - executes reusable workflows as checks
 */
import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Provider that executes workflows as checks
 */
export declare class WorkflowCheckProvider extends CheckProvider {
    private registry;
    private executor;
    private liquid;
    constructor();
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    /**
     * Prepare inputs for workflow execution
     */
    private prepareInputs;
    /**
     * Apply overrides to workflow steps
     */
    private applyOverrides;
    /**
     * Map workflow outputs to check outputs
     */
    private mapOutputs;
    /**
     * Format workflow execution result for display
     */
    /**
     * Execute workflow via state machine engine (M3: nested workflows)
     */
    private executeViaStateMachine;
    /**
     * Compute workflow outputs from state machine execution results
     */
    private computeWorkflowOutputsFromState;
    /**
     * Format workflow result from state machine execution
     */
    private formatWorkflowResultFromStateMachine;
    private formatWorkflowResult;
    /**
     * Load a Visor config file (with steps/checks) and wrap it as a WorkflowDefinition
     * so it can be executed by the state machine as a nested workflow.
     */
    private loadWorkflowFromConfigPath;
}
//# sourceMappingURL=workflow-check-provider.d.ts.map