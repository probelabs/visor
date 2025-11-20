/**
 * Workflow registry for managing reusable workflow definitions
 */
import { WorkflowDefinition, WorkflowRegistryEntry, WorkflowValidationResult, WorkflowImportOptions } from './types/workflow';
/**
 * Registry for managing workflow definitions
 */
export declare class WorkflowRegistry {
    private static instance;
    private workflows;
    private ajv;
    private constructor();
    /**
     * Get the singleton instance of the workflow registry
     */
    static getInstance(): WorkflowRegistry;
    /**
     * Register a workflow definition
     */
    register(workflow: WorkflowDefinition, source?: string, options?: {
        override?: boolean;
    }): WorkflowValidationResult;
    /**
     * Get a workflow by ID
     */
    get(id: string): WorkflowDefinition | undefined;
    /**
     * Check if a workflow exists
     */
    has(id: string): boolean;
    /**
     * List all registered workflows
     */
    list(): WorkflowDefinition[];
    /**
     * Get workflow metadata
     */
    getMetadata(id: string): WorkflowRegistryEntry | undefined;
    /**
     * Remove a workflow from the registry
     */
    unregister(id: string): boolean;
    /**
     * Clear all workflows
     */
    clear(): void;
    /**
     * Import workflows from a file or URL
     */
    import(source: string, options?: WorkflowImportOptions): Promise<WorkflowValidationResult[]>;
    /**
     * Import multiple workflow sources
     */
    importMany(sources: string[], options?: WorkflowImportOptions): Promise<Map<string, WorkflowValidationResult[]>>;
    /**
     * Validate a workflow definition
     */
    validateWorkflow(workflow: WorkflowDefinition): WorkflowValidationResult;
    /**
     * Validate input values against workflow input schema
     */
    validateInputs(workflow: WorkflowDefinition, inputs: Record<string, unknown>): WorkflowValidationResult;
    /**
     * Load workflow content from file or URL
     */
    private loadWorkflowContent;
    /**
     * Parse workflow content (YAML or JSON)
     */
    private parseWorkflowContent;
    /**
     * Detect circular dependencies in workflow steps using DependencyResolver
     */
    private detectCircularDependencies;
    /**
     * Validate a value against a JSON schema
     */
    private validateAgainstSchema;
}
