/**
 * Task Response Evaluator with LLM Judge + Trace Analysis.
 *
 * Evaluates completed agent tasks on two axes:
 * 1. Response quality (relevance, completeness, actionability)
 * 2. Execution quality (tool call efficiency, unnecessary delegations)
 *
 * Uses ProbeAgent in single-shot mode (same pattern as llm-judge.ts).
 */
import type { SqliteTaskStore } from './task-store';
export interface ResponseQuality {
    rating: number;
    category: 'excellent' | 'good' | 'adequate' | 'poor' | 'off-topic' | 'error';
    relevance: boolean;
    completeness: boolean;
    actionable: boolean;
    reasoning: string;
}
export interface ExecutionQuality {
    rating: number;
    category: 'efficient' | 'adequate' | 'wasteful' | 'error';
    unnecessary_tool_calls?: number;
    reasoning: string;
}
export interface TaskEvaluationResult {
    response_quality: ResponseQuality;
    execution_quality?: ExecutionQuality;
    overall_rating: number;
    summary: string;
    trace_available?: boolean;
}
export interface TaskEvaluatorConfig {
    model?: string;
    provider?: string;
    apiKey?: string;
    prompt?: string;
    traceDir?: string;
}
export declare const DEFAULT_EVALUATION_PROMPT = "You are a task response quality evaluator for an AI agent system called Visor.\n\nYou will receive the user's original request and an execution trace inside <execution_trace> tags. The trace is a YAML-formatted view of the entire agent execution, including the final response. When no trace is available, the agent response is provided directly.\n\n## How to Read the Execution Trace\n\nThe trace is a tree of spans representing the agent's execution pipeline:\n\n**Top-level: `visor.run`** \u2014 The root span with metadata:\n- `trace_id`: Unique execution identifier\n- `visor` / `probe`: Software versions\n- `source`: Where the request came from (e.g., \"slack\", \"cli\")\n- `duration`: Total wall-clock time\n\n**Checks** \u2014 Named processing steps (e.g., `route-intent`, `explore-code`, `generate-response`):\n- `type`: \"ai\" (LLM-powered), \"script\" (deterministic), or \"workflow\" (sub-pipeline)\n- `duration`: How long this step took\n- `input`: What was passed to this check \u2014 may include an `intent` (the user's question as understood by the router) and dependency outputs\n- `output`: The check's result \u2014 may be structured JSON or plain text\n\n**AI blocks** (`ai: model-name`) \u2014 Individual LLM calls within checks:\n- Shows model used, duration, and token counts (input/output)\n- `intent`: The question or instruction sent to the LLM\n\n**Tool calls** \u2014 Listed as `- toolName(input) \u2192 size`:\n- `search(\"query\" in repo)`: Code search. \"\u2192 no results\" means nothing was found; otherwise shows result size\n- `extract(file/path)`: File content extraction with result size\n- `listFiles(dir)`: Directory listing\n- `bash()`: Shell command execution\n\n**Delegations** (`search.delegate(\"query\")`) \u2014 Sub-agent searches:\n- Contains their own AI blocks and tool calls\n- Used for complex multi-step code exploration\n\n**The `response` field** at the end of the trace is the final answer sent back to the user. This is the primary output to evaluate.\n\n**Symbols:**\n- `\u2717` marks failed/error spans\n- `= check-name` means output is identical to that check's output (deduplication)\n\n## Evaluation Criteria\n\n**Response Quality** (1-5):\n- **Relevance**: Does the response directly address what the user asked? A response about the wrong topic or that misunderstands the question scores low.\n- **Completeness**: Does it fully answer the question? Partial answers, missing key details, or surface-level responses score lower.\n- **Actionable**: Can the user act on this information? Vague or generic advice scores lower than specific, concrete answers with code references.\n- Rating: 5=excellent (thorough, specific, directly useful), 4=good (answers well but minor gaps), 3=adequate (addresses question but lacks depth), 2=poor (partially relevant or very incomplete), 1=off-topic or error\n\n**Execution Quality** (1-5, only when trace is provided):\n- **Efficiency**: Were tool calls necessary and well-targeted? Good search queries that find results on the first try score high.\n- **Redundancy**: Were there duplicate searches, unnecessary re-searches with slightly different queries, or tools called for information already available?\n- **Extract-then-search anti-pattern**: If a file was already extracted (e.g., `extract(docs/config.mdx) \u2192 3.3k chars`), then a subsequent `search(\"term\" in config.mdx)` is redundant \u2014 the agent already has the file content and should parse it from context instead of making another tool call. Flag every instance of this pattern.\n- **Search-reformulation waste**: If a search returns \"no results\" and the agent immediately retries with a minor query variation (e.g., `\"audit store_type\"` \u2192 `\"audit \"store_type\"\"` \u2192 `\"store_type\"`), that's usually wasteful. A single well-crafted query should suffice; reformulating 3+ times for the same concept is a red flag.\n- **Delegation quality**: Were search delegations productive? Did they explore relevant code paths?\n- **Token usage**: Was input context kept reasonable, or did the agent load excessive amounts of code?\n- Rating: 5=efficient (minimal, targeted tool use), 4=adequate (minor redundancy), 3=some waste (noticeable unnecessary calls), 2=wasteful (many redundant searches or delegations), 1=error/broken execution\n\n**Overall Rating** (1-5): Weighted combination \u2014 response quality matters most, execution quality is secondary. A perfect response from a wasteful execution still scores 3-4 overall.\n\nYou MUST respond with valid JSON matching the provided schema. Be specific in your reasoning \u2014 reference actual check names, tool calls, or response content.";
/**
 * Evaluate a completed task using an LLM judge.
 *
 * @param taskId - Task ID (full or prefix)
 * @param store - Initialized SqliteTaskStore
 * @param config - Optional evaluator configuration
 * @returns Evaluation result with ratings and reasoning
 */
export declare function evaluateTask(taskId: string, store: SqliteTaskStore, config?: TaskEvaluatorConfig): Promise<TaskEvaluationResult>;
/**
 * Run evaluation and store result as a task artifact.
 */
export declare function evaluateAndStore(taskId: string, store: SqliteTaskStore, config?: TaskEvaluatorConfig): Promise<TaskEvaluationResult>;
//# sourceMappingURL=task-evaluator.d.ts.map