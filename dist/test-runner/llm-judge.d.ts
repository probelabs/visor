/**
 * LLM-as-Judge evaluator for YAML test framework.
 *
 * Sends step/workflow outputs to an LLM for semantic evaluation.
 * Uses ProbeAgent (same as the rest of Visor) for model routing and structured output.
 */
/** Simple pass/fail verdict (default schema) */
export interface LlmJudgeVerdict {
    pass: boolean;
    reason: string;
}
/** Single judge assertion from the YAML expect block */
export interface LlmJudgeExpectation {
    /** What to judge: step output or workflow_output */
    step?: string;
    /** JSON path into the output (default: root object) */
    path?: string;
    /** Index selector: 'first', 'last', or number (default: 'last') */
    index?: number | 'first' | 'last';
    /** Use workflow_output instead of step output */
    workflow_output?: boolean;
    /** The evaluation prompt sent to the LLM */
    prompt: string;
    /** Model to use (default: from test defaults or VISOR_JUDGE_MODEL env) */
    model?: string;
    /**
     * Schema mode:
     * - omitted or "verdict": simple { pass, reason }
     * - object with properties: structured extraction with custom fields
     */
    schema?: 'verdict' | LlmJudgeCustomSchema;
    /** For custom schemas: field-level assertions on the extracted result */
    assert?: Record<string, unknown>;
}
/** Custom structured schema for extraction */
export interface LlmJudgeCustomSchema {
    properties: Record<string, LlmJudgeSchemaProperty>;
    required?: string[];
}
export interface LlmJudgeSchemaProperty {
    type: 'string' | 'number' | 'boolean' | 'array';
    description?: string;
    enum?: unknown[];
    items?: {
        type: string;
    };
}
/** Configuration for the judge (from test defaults or env) */
export interface LlmJudgeConfig {
    model?: string;
    provider?: string;
    apiKey?: string;
    baseURL?: string;
}
export declare function evaluateLlmJudge(expectation: LlmJudgeExpectation, output: unknown, config?: LlmJudgeConfig): Promise<{
    errors: string[];
    result?: Record<string, unknown>;
}>;
//# sourceMappingURL=llm-judge.d.ts.map