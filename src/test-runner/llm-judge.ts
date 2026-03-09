/**
 * LLM-as-Judge evaluator for YAML test framework.
 *
 * Sends step/workflow outputs to an LLM for semantic evaluation.
 * Uses ProbeAgent (same as the rest of Visor) for model routing and structured output.
 */

import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  items?: { type: string };
}

/** Configuration for the judge (from test defaults or env) */
export interface LlmJudgeConfig {
  model?: string;
  provider?: string; // 'google' | 'openai' | 'anthropic'
  apiKey?: string;
  baseURL?: string;
}

// ---------------------------------------------------------------------------
// JSON Schema building (for ProbeAgent structured output)
// ---------------------------------------------------------------------------

function buildVerdictJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      pass: { type: 'boolean', description: 'Whether the output meets the criteria' },
      reason: { type: 'string', description: 'Brief explanation of the verdict' },
    },
    required: ['pass', 'reason'],
  };
}

function buildCustomJsonSchema(def: LlmJudgeCustomSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, prop] of Object.entries(def.properties)) {
    const propSchema: Record<string, unknown> = { type: prop.type };
    if (prop.description) propSchema.description = prop.description;
    if (prop.enum) propSchema.enum = prop.enum;
    if (prop.type === 'array') {
      propSchema.items = prop.items || { type: 'string' };
    }
    properties[key] = propSchema;
    if (def.required?.includes(key)) {
      required.push(key);
    }
  }

  // Always include pass and reason for verdict
  if (!properties.pass) {
    properties.pass = { type: 'boolean', description: 'Whether the output meets the criteria' };
  }
  if (!properties.reason) {
    properties.reason = { type: 'string', description: 'Brief explanation of the verdict' };
  }
  if (!required.includes('pass')) required.push('pass');
  if (!required.includes('reason')) required.push('reason');

  return {
    type: 'object',
    properties,
    required,
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export async function evaluateLlmJudge(
  expectation: LlmJudgeExpectation,
  output: unknown,
  config?: LlmJudgeConfig
): Promise<{ errors: string[]; result?: Record<string, unknown> }> {
  const errors: string[] = [];
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

  // Build the prompt
  const systemPrompt = `You are a test evaluator. Analyze the given output and provide a structured verdict.
Be strict but fair. Focus on the semantic content, not formatting.
You MUST respond with valid JSON matching the provided schema.`;

  const userPrompt = `## Evaluation Criteria
${expectation.prompt}

## Output to Evaluate
${outputStr}`;

  try {
    // Build JSON schema for structured output
    const jsonSchema =
      !expectation.schema || expectation.schema === 'verdict'
        ? buildVerdictJsonSchema()
        : buildCustomJsonSchema(expectation.schema);

    // Use ProbeAgent for the LLM call — same as the rest of Visor
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ProbeAgent } = require('@probelabs/probe');

    const model = expectation.model || config?.model || process.env.VISOR_JUDGE_MODEL;
    const provider = config?.provider;

    const agentOptions: Record<string, unknown> = {
      sessionId: `visor-llm-judge-${Date.now()}`,
      systemPrompt,
      maxIterations: 1, // Judge doesn't need tools, single-shot
      disableTools: true, // No tool use for judging
    };

    if (model) agentOptions.model = model;
    if (provider) agentOptions.provider = provider;
    if (config?.apiKey) {
      // Set API key in environment for ProbeAgent
      const envKey =
        provider === 'openai'
          ? 'OPENAI_API_KEY'
          : provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY'
            : 'GOOGLE_API_KEY';
      process.env[envKey] = config.apiKey;
    }

    const agent = new ProbeAgent(agentOptions);
    if (typeof agent.initialize === 'function') {
      await agent.initialize();
    }

    const schemaStr = JSON.stringify(jsonSchema);
    const response = await agent.answer(userPrompt, undefined, { schema: schemaStr });

    // Parse the JSON response from ProbeAgent
    let result: Record<string, unknown>;
    try {
      // ProbeAgent may return the JSON wrapped in markdown code blocks
      const cleaned = response
        .replace(/^```(?:json)?\s*\n?/m, '')
        .replace(/\n?```\s*$/m, '')
        .trim();
      result = JSON.parse(cleaned);
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error(`Failed to parse LLM judge response as JSON: ${response.slice(0, 200)}`);
      }
    }

    // Check pass/fail verdict
    if (result.pass === false) {
      const reason = result.reason || 'LLM judge returned pass=false';
      errors.push(`LLM judge: ${reason}`);
    }

    // Check custom assertions if provided
    if (expectation.assert) {
      for (const [field, expected] of Object.entries(expectation.assert)) {
        const actual = result[field];
        if (expected === true || expected === false) {
          if (actual !== expected) {
            errors.push(
              `LLM judge field "${field}": expected ${expected}, got ${JSON.stringify(actual)}`
            );
          }
        } else if (typeof expected === 'string') {
          if (String(actual) !== expected) {
            errors.push(`LLM judge field "${field}": expected "${expected}", got "${actual}"`);
          }
        } else if (Array.isArray(expected)) {
          if (!Array.isArray(actual)) {
            errors.push(`LLM judge field "${field}": expected array, got ${typeof actual}`);
          } else {
            for (const item of expected) {
              if (!actual.includes(item)) {
                errors.push(`LLM judge field "${field}": missing expected item "${item}"`);
              }
            }
          }
        }
      }
    }

    return { errors, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[LLM Judge] Failed: ${msg}`);
    errors.push(`LLM judge error: ${msg}`);
    return { errors };
  }
}
