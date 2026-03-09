/**
 * LLM-as-Judge evaluator for YAML test framework.
 *
 * Sends step/workflow outputs to an LLM for semantic evaluation.
 * Supports simple pass/fail verdicts and structured extraction schemas.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
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
// Model creation
// ---------------------------------------------------------------------------

function resolveModelId(explicit?: string): string {
  return explicit || process.env.VISOR_JUDGE_MODEL || 'gemini-2.0-flash';
}

function createModel(modelId: string, config?: LlmJudgeConfig) {
  // Determine provider from model name prefix or explicit config
  const provider =
    config?.provider ||
    (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')
      ? 'openai'
      : modelId.startsWith('claude')
        ? 'anthropic'
        : 'google');

  if (provider === 'openai') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createOpenAI } = require('@ai-sdk/openai');
    const openai = createOpenAI({
      apiKey: config?.apiKey || process.env.OPENAI_API_KEY,
      ...(config?.baseURL ? { baseURL: config.baseURL } : {}),
    });
    return openai(modelId);
  }

  if (provider === 'anthropic') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAnthropic } = require('@ai-sdk/anthropic');
    const anthropic = createAnthropic({
      apiKey: config?.apiKey || process.env.ANTHROPIC_API_KEY,
      ...(config?.baseURL ? { baseURL: config.baseURL } : {}),
    });
    return anthropic(modelId);
  }

  // Default: Google
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createGoogleGenerativeAI } = require('@ai-sdk/google');
  const google = createGoogleGenerativeAI({
    apiKey:
      config?.apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
    ...(config?.baseURL ? { baseURL: config.baseURL } : {}),
  });
  return google(modelId);
}

// ---------------------------------------------------------------------------
// Schema building
// ---------------------------------------------------------------------------

function buildVerdictSchema() {
  return z.object({
    pass: z.boolean().describe('Whether the output meets the criteria'),
    reason: z.string().describe('Brief explanation of the verdict'),
  });
}

function buildCustomSchema(def: LlmJudgeCustomSchema) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(def.properties)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'boolean':
        field = z.boolean();
        break;
      case 'number':
        field = z.number();
        break;
      case 'array':
        field = z.array(z.string());
        break;
      case 'string':
      default:
        if (prop.enum) {
          field = z.enum(prop.enum.map(String) as [string, ...string[]]);
        } else {
          field = z.string();
        }
        break;
    }
    if (prop.description) field = field.describe(prop.description);
    // Make optional unless in required list
    if (!def.required?.includes(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }
  // Always include pass and reason for verdict
  if (!shape.pass) shape.pass = z.boolean().describe('Whether the output meets the criteria');
  if (!shape.reason) shape.reason = z.string().describe('Brief explanation of the verdict');
  return z.object(shape);
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
  const modelId = resolveModelId(expectation.model || config?.model);
  const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

  // Build the system + user message
  const systemPrompt = `You are a test evaluator. Analyze the given output and provide a structured verdict.
Be strict but fair. Focus on the semantic content, not formatting.`;

  const userPrompt = `## Evaluation Criteria
${expectation.prompt}

## Output to Evaluate
${outputStr}`;

  try {
    const model = createModel(modelId, config);
    const schema =
      !expectation.schema || expectation.schema === 'verdict'
        ? buildVerdictSchema()
        : buildCustomSchema(expectation.schema);

    const { object } = await generateObject({
      model,
      schema,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0,
    });

    const result = object as Record<string, unknown>;

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
