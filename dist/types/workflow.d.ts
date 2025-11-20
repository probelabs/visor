/**
 * Types for reusable workflow system
 */
import { CheckConfig, EventTrigger } from './config';
/**
 * JSON Schema type for workflow parameter definitions
 */
export interface JsonSchema {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
    description?: string;
    default?: unknown;
    enum?: unknown[];
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    required?: string[];
    additionalProperties?: boolean | JsonSchema;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
}
/**
 * Input parameter definition for a workflow
 */
export interface WorkflowInputParam {
    /** Parameter name */
    name: string;
    /** JSON Schema for validation */
    schema: JsonSchema;
    /** Whether this parameter is required */
    required?: boolean;
    /** Default value if not provided */
    default?: unknown;
    /** Description of the parameter */
    description?: string;
}
/**
 * Output parameter definition for a workflow
 */
export interface WorkflowOutputParam {
    /** Output parameter name */
    name: string;
    /** JSON Schema for validation */
    schema?: JsonSchema;
    /** Description of the output */
    description?: string;
    /** JavaScript expression to compute the output value from step results */
    value_js?: string;
    /** Liquid template to compute the output value */
    value?: string;
}
/**
 * Step definition within a workflow
 */
export interface WorkflowStep extends CheckConfig {
    /** Step ID within the workflow (optional, derived from key in steps object) */
    id?: string;
    /** Display name for the step */
    name?: string;
    /** Step description */
    description?: string;
    /** Input mappings - maps workflow inputs to step parameters */
    inputs?: Record<string, string | WorkflowInputMapping>;
}
/**
 * Input mapping for workflow steps
 */
export interface WorkflowInputMapping {
    /** Source of the value: 'param', 'step', 'constant', 'expression' */
    source: 'param' | 'step' | 'constant' | 'expression';
    /** Value or reference based on source type */
    value: unknown;
    /** For 'step' source: the step ID to get output from */
    stepId?: string;
    /** For 'step' source: the output parameter name */
    outputParam?: string;
    /** JavaScript expression for dynamic mapping */
    expression?: string;
    /** Liquid template for dynamic mapping */
    template?: string;
}
/**
 * Complete workflow definition
 * Extends the base visor config structure with workflow-specific metadata
 */
export interface WorkflowDefinition {
    /** Unique workflow ID */
    id: string;
    /** Workflow name */
    name: string;
    /** Workflow description */
    description?: string;
    /** Version of the workflow */
    version?: string;
    /** Input parameters */
    inputs?: WorkflowInputParam[];
    /** Output parameters */
    outputs?: WorkflowOutputParam[];
    /** Workflow steps - at root level like regular configs */
    steps: Record<string, WorkflowStep>;
    /** Tags for categorization */
    tags?: string[];
    /** Events that can trigger this workflow */
    on?: EventTrigger[];
    /** Default configuration values for steps */
    defaults?: Partial<CheckConfig>;
    /** Category for organizing workflows */
    category?: string;
    /** Author information */
    author?: {
        name?: string;
        email?: string;
        url?: string;
    };
    /** License information */
    license?: string;
    /** Example usage */
    examples?: WorkflowExample[];
    /**
     * Test checks for this workflow (only used when running standalone)
     * These are NOT imported when the workflow is imported into another config
     */
    tests?: Record<string, CheckConfig>;
}
/**
 * Example usage of a workflow
 */
export interface WorkflowExample {
    /** Example name */
    name: string;
    /** Example description */
    description?: string;
    /** Input values for the example */
    inputs: Record<string, unknown>;
    /** Expected outputs (for documentation) */
    expectedOutputs?: Record<string, unknown>;
}
/**
 * Reference to a workflow in check configuration
 */
export interface WorkflowReference {
    /** Workflow ID or path to import */
    workflow: string;
    /** Input parameter values */
    inputs?: Record<string, unknown>;
    /** Override specific step configurations */
    overrides?: Record<string, Partial<CheckConfig>>;
    /** Map workflow outputs to check outputs */
    outputMapping?: Record<string, string>;
}
/**
 * Workflow execution context
 */
export interface WorkflowExecutionContext {
    /** Workflow instance ID */
    instanceId: string;
    /** Parent check ID if workflow is used as a step */
    parentCheckId?: string;
    /** Input values provided */
    inputs: Record<string, unknown>;
    /** Step results accumulated during execution */
    stepResults: Map<string, unknown>;
    /** Output values computed */
    outputs?: Record<string, unknown>;
    /** Execution metadata */
    metadata?: {
        startTime: number;
        endTime?: number;
        duration?: number;
        status: 'running' | 'completed' | 'failed' | 'skipped';
        error?: string;
    };
}
/**
 * Workflow validation result
 */
export interface WorkflowValidationResult {
    /** Whether the workflow is valid */
    valid: boolean;
    /** Validation errors */
    errors?: Array<{
        path: string;
        message: string;
        value?: unknown;
    }>;
    /** Validation warnings */
    warnings?: Array<{
        path: string;
        message: string;
    }>;
}
/**
 * Workflow registry entry
 */
export interface WorkflowRegistryEntry {
    /** Workflow definition */
    definition: WorkflowDefinition;
    /** Source of the workflow (file path, URL, or 'inline') */
    source: string;
    /** When the workflow was registered */
    registeredAt: Date;
    /** Usage statistics */
    usage?: {
        count: number;
        lastUsed?: Date;
        averageDuration?: number;
    };
}
/**
 * Options for importing workflows
 */
export interface WorkflowImportOptions {
    /** Base path for resolving relative imports */
    basePath?: string;
    /** Whether to validate workflows on import */
    validate?: boolean;
    /** Whether to override existing workflows */
    override?: boolean;
    /** Custom validators */
    validators?: Array<(workflow: WorkflowDefinition) => WorkflowValidationResult>;
}
/**
 * Workflow execution options
 */
export interface WorkflowExecutionOptions {
    /** Maximum execution time in milliseconds */
    timeout?: number;
    /** Whether to continue on step failure */
    continueOnError?: boolean;
    /** Debug mode */
    debug?: boolean;
    /** Dry run - validate but don't execute */
    dryRun?: boolean;
}
//# sourceMappingURL=workflow.d.ts.map