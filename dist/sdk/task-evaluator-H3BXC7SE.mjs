import {
  init_trace_serializer,
  serializeTraceForPrompt
} from "./chunk-IY5PQ5EN.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import "./chunk-B2OUZAWY.mjs";
import {
  __esm,
  __require
} from "./chunk-J7LXIPZS.mjs";

// src/agent-protocol/task-evaluator.ts
import crypto from "crypto";
function buildEvaluationSchema(includeExecution) {
  const schema = {
    type: "object",
    required: ["response_quality", "overall_rating", "summary"],
    properties: {
      response_quality: {
        type: "object",
        required: ["rating", "category", "relevance", "completeness", "actionable", "reasoning"],
        properties: {
          rating: { type: "integer", minimum: 1, maximum: 5 },
          category: {
            type: "string",
            enum: ["excellent", "good", "adequate", "poor", "off-topic", "error"]
          },
          relevance: { type: "boolean" },
          completeness: { type: "boolean" },
          actionable: { type: "boolean" },
          reasoning: { type: "string" }
        }
      },
      overall_rating: { type: "integer", minimum: 1, maximum: 5 },
      summary: { type: "string" }
    }
  };
  if (includeExecution) {
    schema.required.push("execution_quality");
    schema.properties.execution_quality = {
      type: "object",
      required: ["rating", "category", "reasoning"],
      properties: {
        rating: { type: "integer", minimum: 1, maximum: 5 },
        category: { type: "string", enum: ["efficient", "adequate", "wasteful", "error"] },
        unnecessary_tool_calls: { type: "integer" },
        reasoning: { type: "string" }
      }
    };
  }
  return schema;
}
async function evaluateTask(taskId, store, config) {
  const { rows } = store.listTasksRaw({ limit: 500 });
  const match = rows.find((r) => r.id === taskId || r.id.startsWith(taskId));
  if (!match) {
    throw new Error(`Task not found: ${taskId}`);
  }
  const fullTask = store.getTask(match.id);
  if (!fullTask) {
    throw new Error(`Task data not found: ${match.id}`);
  }
  const requestText = match.request_message || "No request text available";
  let responseText = "No response available";
  if (fullTask.status?.message) {
    const parts = fullTask.status.message.parts ?? [];
    const textPart = parts.find((p) => typeof p.text === "string");
    if (textPart) {
      responseText = textPart.text;
    }
  }
  if (fullTask.status.state === "failed" && responseText === "No response available") {
    return {
      response_quality: {
        rating: 1,
        category: "error",
        relevance: false,
        completeness: false,
        actionable: false,
        reasoning: "Task failed without producing a response."
      },
      overall_rating: 1,
      summary: "Task failed without producing a response."
    };
  }
  let traceTree;
  const traceId = match.metadata?.trace_id;
  const traceFile = match.metadata?.trace_file;
  if (traceFile || traceId) {
    try {
      const traceRef = traceFile || traceId;
      traceTree = await serializeTraceForPrompt(
        traceRef,
        1e6,
        { traceDir: config?.traceDir },
        responseText !== "No response available" ? responseText : void 0,
        traceId
      );
      if (traceTree === "(no trace data available)") {
        traceTree = void 0;
      }
    } catch (err) {
      logger.debug(
        `[TaskEvaluator] Failed to load trace: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  const systemPrompt = config?.prompt || process.env.VISOR_EVAL_PROMPT || DEFAULT_EVALUATION_PROMPT;
  const hasTrace = !!traceTree;
  let userPrompt;
  if (traceTree) {
    userPrompt = `<user_request>
${requestText}
</user_request>

<execution_trace>
${traceTree}
</execution_trace>`;
  } else {
    userPrompt = `<user_request>
${requestText}
</user_request>

<agent_response>
${responseText}
</agent_response>`;
  }
  const { ProbeAgent } = __require("@probelabs/probe");
  const model = config?.model || process.env.VISOR_EVAL_MODEL || process.env.VISOR_JUDGE_MODEL || void 0;
  const provider = config?.provider || process.env.VISOR_EVAL_PROVIDER || void 0;
  const agentOptions = {
    sessionId: `visor-task-eval-${Date.now()}`,
    systemPrompt,
    maxIterations: 1,
    disableTools: true
  };
  if (model) agentOptions.model = model;
  if (provider) agentOptions.provider = provider;
  if (config?.apiKey) {
    const envKey = provider === "openai" ? "OPENAI_API_KEY" : provider === "anthropic" ? "ANTHROPIC_API_KEY" : "GOOGLE_API_KEY";
    process.env[envKey] = config.apiKey;
  }
  const agent = new ProbeAgent(agentOptions);
  if (typeof agent.initialize === "function") {
    await agent.initialize();
  }
  const jsonSchema = buildEvaluationSchema(hasTrace);
  const schemaStr = JSON.stringify(jsonSchema);
  const response = await agent.answer(userPrompt, void 0, { schema: schemaStr });
  let result;
  try {
    const cleaned = response.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
    result = JSON.parse(cleaned);
  } catch {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      result = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse evaluation response as JSON: ${response.slice(0, 200)}`);
    }
  }
  if (!hasTrace) {
    const MAX_RATING_WITHOUT_TRACE = 4;
    if (result.overall_rating > MAX_RATING_WITHOUT_TRACE) {
      result.overall_rating = MAX_RATING_WITHOUT_TRACE;
    }
    result.trace_available = false;
    result.summary = `[No trace available \u2014 execution quality not assessed, rating capped at ${MAX_RATING_WITHOUT_TRACE}/5] ${result.summary}`;
  } else {
    result.trace_available = true;
  }
  return result;
}
async function evaluateAndStore(taskId, store, config) {
  const result = await evaluateTask(taskId, store, config);
  const { rows } = store.listTasksRaw({ limit: 500 });
  const match = rows.find((r) => r.id === taskId || r.id.startsWith(taskId));
  if (match) {
    store.addArtifact(match.id, {
      artifact_id: crypto.randomUUID(),
      name: "evaluation",
      parts: [{ text: JSON.stringify(result), media_type: "application/json" }]
    });
  }
  return result;
}
var DEFAULT_EVALUATION_PROMPT;
var init_task_evaluator = __esm({
  "src/agent-protocol/task-evaluator.ts"() {
    init_logger();
    init_trace_serializer();
    DEFAULT_EVALUATION_PROMPT = `You are a task response quality evaluator for an AI agent system called Visor.

You will receive the user's original request and an execution trace inside <execution_trace> tags. The trace is a YAML-formatted view of the entire agent execution, including the final response. When no trace is available, the agent response is provided directly.

## How to Read the Execution Trace

The trace is a tree of spans representing the agent's execution pipeline:

**Top-level: \`visor.run\`** \u2014 The root span with metadata:
- \`trace_id\`: Unique execution identifier
- \`visor\` / \`probe\`: Software versions
- \`source\`: Where the request came from (e.g., "slack", "cli")
- \`duration\`: Total wall-clock time

**Checks** \u2014 Named processing steps (e.g., \`route-intent\`, \`explore-code\`, \`generate-response\`):
- \`type\`: "ai" (LLM-powered), "script" (deterministic), or "workflow" (sub-pipeline)
- \`duration\`: How long this step took
- \`input\`: What was passed to this check \u2014 may include an \`intent\` (the user's question as understood by the router) and dependency outputs
- \`output\`: The check's result \u2014 may be structured JSON or plain text

**AI blocks** (\`ai: model-name\`) \u2014 Individual LLM calls within checks:
- Shows model used, duration, and token counts (input/output)
- \`intent\`: The question or instruction sent to the LLM

**Tool calls** \u2014 Listed as \`- toolName(input) \u2192 size\`:
- \`search("query" in repo)\`: Code search. "\u2192 no results" means nothing was found; otherwise shows result size
- \`extract(file/path)\`: File content extraction with result size
- \`listFiles(dir)\`: Directory listing
- \`bash()\`: Shell command execution

**Delegations** (\`search.delegate("query")\`) \u2014 Sub-agent searches:
- Contains their own AI blocks and tool calls
- Used for complex multi-step code exploration

**The \`response\` field** at the end of the trace is the final answer sent back to the user. This is the primary output to evaluate.

**Symbols:**
- \`\u2717\` marks failed/error spans
- \`= check-name\` means output is identical to that check's output (deduplication)

## Evaluation Criteria

**Response Quality** (1-5):
- **Relevance**: Does the response directly address what the user asked? A response about the wrong topic or that misunderstands the question scores low.
- **Completeness**: Does it fully answer the question? Partial answers, missing key details, or surface-level responses score lower.
- **Actionable**: Can the user act on this information? Vague or generic advice scores lower than specific, concrete answers with code references.
- Rating: 5=excellent (thorough, specific, directly useful), 4=good (answers well but minor gaps), 3=adequate (addresses question but lacks depth), 2=poor (partially relevant or very incomplete), 1=off-topic or error

**Execution Quality** (1-5, only when trace is provided):
- **Efficiency**: Were tool calls necessary and well-targeted? Good search queries that find results on the first try score high.
- **Redundancy**: Were there duplicate searches, unnecessary re-searches with slightly different queries, or tools called for information already available?
- **Extract-then-search anti-pattern**: If a file was already extracted (e.g., \`extract(docs/config.mdx) \u2192 3.3k chars\`), then a subsequent \`search("term" in config.mdx)\` is redundant \u2014 the agent already has the file content and should parse it from context instead of making another tool call. Flag every instance of this pattern.
- **Search-reformulation waste**: If a search returns "no results" and the agent immediately retries with a minor query variation (e.g., \`"audit store_type"\` \u2192 \`"audit "store_type""\` \u2192 \`"store_type"\`), that's usually wasteful. A single well-crafted query should suffice; reformulating 3+ times for the same concept is a red flag.
- **Delegation quality**: Were search delegations productive? Did they explore relevant code paths?
- **Token usage**: Was input context kept reasonable, or did the agent load excessive amounts of code?
- Rating: 5=efficient (minimal, targeted tool use), 4=adequate (minor redundancy), 3=some waste (noticeable unnecessary calls), 2=wasteful (many redundant searches or delegations), 1=error/broken execution

**Overall Rating** (1-5): Weighted combination \u2014 response quality matters most, execution quality is secondary. A perfect response from a wasteful execution still scores 3-4 overall.

You MUST respond with valid JSON matching the provided schema. Be specific in your reasoning \u2014 reference actual check names, tool calls, or response content.`;
  }
});
init_task_evaluator();
export {
  DEFAULT_EVALUATION_PROMPT,
  evaluateAndStore,
  evaluateTask
};
//# sourceMappingURL=task-evaluator-H3BXC7SE.mjs.map