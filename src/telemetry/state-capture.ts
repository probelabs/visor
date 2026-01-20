/**
 * Enhanced state capture for OTEL spans to enable interactive debugging.
 *
 * This module provides utilities to capture complete execution state in span
 * attributes, enabling time-travel debugging and full state inspection.
 */

import { Span } from './lazy-otel';

const MAX_ATTRIBUTE_LENGTH = 10000; // Truncate large values
const MAX_ARRAY_ITEMS = 100; // Limit array size in attributes

// Patterns that indicate sensitive environment variables (case-insensitive)
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth/i,
  /credential/i,
  /private[_-]?key/i,
  /^sk-/i, // OpenAI-style keys
  /^AIza/i, // Google API keys
];

/**
 * Check if an environment variable name is sensitive
 */
function isSensitiveEnvVar(name: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(name));
}

/**
 * Sanitize context for telemetry by redacting sensitive environment variables.
 * Returns a new object with env values redacted (keys preserved).
 */
export function sanitizeContextForTelemetry(
  context: Record<string, unknown>
): Record<string, unknown> {
  if (!context || typeof context !== 'object') return context;

  const sanitized = { ...context };

  // Sanitize env object if present
  if (sanitized.env && typeof sanitized.env === 'object') {
    const sanitizedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitized.env as Record<string, unknown>)) {
      if (isSensitiveEnvVar(key)) {
        sanitizedEnv[key] = '[REDACTED]';
      } else {
        sanitizedEnv[key] = String(value);
      }
    }
    sanitized.env = sanitizedEnv;
  }

  return sanitized;
}

/**
 * Safely serialize a value for OTEL span attributes.
 * Handles truncation, circular refs, and type conversions.
 */
function safeSerialize(value: unknown, maxLength = MAX_ATTRIBUTE_LENGTH): string {
  try {
    if (value === undefined || value === null) return String(value);

    // Detect circular references
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      // Truncate long strings
      if (typeof val === 'string' && val.length > maxLength) {
        return val.substring(0, maxLength) + '...[truncated]';
      }
      return val;
    });

    if (json.length > maxLength) {
      return json.substring(0, maxLength) + '...[truncated]';
    }
    return json;
  } catch (err) {
    return `[Error serializing: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

/**
 * Capture check input context (Liquid template variables) in span.
 */
export function captureCheckInputContext(span: Span, context: Record<string, unknown>): void {
  try {
    // Sanitize context to redact sensitive env vars before capturing
    const sanitizedContext = sanitizeContextForTelemetry(context);

    // Capture key context variables
    const keys = Object.keys(sanitizedContext);
    span.setAttribute('visor.check.input.keys', keys.join(','));
    span.setAttribute('visor.check.input.count', keys.length);

    // Capture full context as JSON (with size limit) - now sanitized
    span.setAttribute('visor.check.input.context', safeSerialize(sanitizedContext));

    // Capture specific important variables separately for easy querying
    // Use sanitizedContext consistently to avoid leaking sensitive data
    if (sanitizedContext.pr) {
      span.setAttribute('visor.check.input.pr', safeSerialize(sanitizedContext.pr, 1000));
    }
    if (sanitizedContext.outputs) {
      span.setAttribute('visor.check.input.outputs', safeSerialize(sanitizedContext.outputs, 5000));
    }
    if (sanitizedContext.env) {
      span.setAttribute(
        'visor.check.input.env_keys',
        Object.keys(sanitizedContext.env as object).join(',')
      );
    }
  } catch (err) {
    try {
      span.setAttribute('visor.check.input.error', String(err));
    } catch {
      // Ignore if we can't even set the error attribute
    }
  }
}

/**
 * Capture check output in span.
 */
export function captureCheckOutput(span: Span, output: unknown): void {
  try {
    span.setAttribute('visor.check.output.type', typeof output);

    if (Array.isArray(output)) {
      span.setAttribute('visor.check.output.length', output.length);
      // Store first few items for preview
      const preview = output.slice(0, 10);
      span.setAttribute('visor.check.output.preview', safeSerialize(preview, 2000));
    }

    // Full output (truncated if needed)
    span.setAttribute('visor.check.output', safeSerialize(output));
  } catch (err) {
    try {
      span.setAttribute('visor.check.output.error', String(err));
    } catch {
      // Ignore if we can't even set the error attribute
    }
  }
}

/**
 * Capture forEach iteration state.
 */
export function captureForEachState(
  span: Span,
  items: unknown[],
  index: number,
  currentItem: unknown
): void {
  try {
    span.setAttribute('visor.foreach.total', items.length);
    span.setAttribute('visor.foreach.index', index);
    span.setAttribute('visor.foreach.current_item', safeSerialize(currentItem, 500));

    // Store all items if not too large
    if (items.length <= MAX_ARRAY_ITEMS) {
      span.setAttribute('visor.foreach.items', safeSerialize(items));
    } else {
      span.setAttribute(
        'visor.foreach.items.preview',
        safeSerialize(items.slice(0, MAX_ARRAY_ITEMS))
      );
      span.setAttribute('visor.foreach.items.truncated', true);
    }
  } catch (err) {
    span.setAttribute('visor.foreach.error', String(err));
  }
}

/**
 * Capture Liquid template evaluation details.
 */
export function captureLiquidEvaluation(
  span: Span,
  template: string,
  context: Record<string, unknown>,
  result: string
): void {
  try {
    span.setAttribute('visor.liquid.template', template.substring(0, 1000));
    span.setAttribute('visor.liquid.template.length', template.length);
    span.setAttribute('visor.liquid.result', result.substring(0, 2000));
    span.setAttribute('visor.liquid.result.length', result.length);
    span.setAttribute('visor.liquid.context', safeSerialize(context, 3000));
  } catch (err) {
    span.setAttribute('visor.liquid.error', String(err));
  }
}

/**
 * Capture JavaScript transform execution.
 */
export function captureTransformJS(
  span: Span,
  code: string,
  input: unknown,
  output: unknown
): void {
  try {
    // Truncate long code while keeping plain string (no JSON quoting)
    const codePreview = code.length > 2000 ? code.substring(0, 2000) + '...[truncated]' : code;
    span.setAttribute('visor.transform.code', codePreview);
    span.setAttribute('visor.transform.code.length', code.length);
    span.setAttribute('visor.transform.input', safeSerialize(input, 2000));
    span.setAttribute('visor.transform.output', safeSerialize(output, 2000));
  } catch (err) {
    span.setAttribute('visor.transform.error', String(err));
  }
}

/**
 * Capture provider request/response summary (safe, no raw AI content).
 */
export function captureProviderCall(
  span: Span,
  providerType: string,
  request: { prompt?: string; model?: string; [key: string]: unknown },
  response: { content?: string; tokens?: number; [key: string]: unknown }
): void {
  try {
    span.setAttribute('visor.provider.type', providerType);
    const fullCapture =
      process.env.VISOR_TELEMETRY_FULL_CAPTURE === 'true' ||
      process.env.VISOR_TELEMETRY_FULL_CAPTURE === '1';

    // Request summary
    if (request.model) span.setAttribute('visor.provider.request.model', String(request.model));
    if (request.prompt) {
      span.setAttribute('visor.provider.request.prompt.length', request.prompt.length);
      span.setAttribute('visor.provider.request.prompt.preview', request.prompt.substring(0, 500));
      if (fullCapture) {
        span.setAttribute('visor.provider.request.prompt', safeSerialize(request.prompt));
      }
    }

    // Response summary
    if (response.content) {
      span.setAttribute('visor.provider.response.length', response.content.length);
      span.setAttribute('visor.provider.response.preview', response.content.substring(0, 500));
      if (fullCapture) {
        span.setAttribute('visor.provider.response.content', safeSerialize(response.content));
      }
    }
    if (response.tokens) {
      span.setAttribute('visor.provider.response.tokens', response.tokens);
    }
  } catch (err) {
    span.setAttribute('visor.provider.error', String(err));
  }
}

/**
 * Capture conditional evaluation (if/fail_if).
 */
export function captureConditionalEvaluation(
  span: Span,
  condition: string,
  result: boolean,
  context: Record<string, unknown>
): void {
  try {
    span.setAttribute('visor.condition.expression', condition.substring(0, 500));
    span.setAttribute('visor.condition.result', result);
    span.setAttribute('visor.condition.context', safeSerialize(context, 2000));
  } catch (err) {
    span.setAttribute('visor.condition.error', String(err));
  }
}

/**
 * Capture routing decision (retry/goto/run).
 */
export function captureRoutingDecision(
  span: Span,
  action: 'retry' | 'goto' | 'run',
  target: string | string[],
  condition?: string
): void {
  try {
    span.setAttribute('visor.routing.action', action);
    span.setAttribute('visor.routing.target', Array.isArray(target) ? target.join(',') : target);
    if (condition) {
      span.setAttribute('visor.routing.condition', condition.substring(0, 500));
    }
  } catch (err) {
    span.setAttribute('visor.routing.error', String(err));
  }
}

/**
 * Create a snapshot of the entire execution state at a point in time.
 * This is added as a span event for time-travel debugging.
 */
export function captureStateSnapshot(
  span: Span,
  checkId: string,
  outputs: Record<string, unknown>,
  memory: Record<string, unknown>
): void {
  try {
    span.addEvent('state.snapshot', {
      'visor.snapshot.check_id': checkId,
      'visor.snapshot.outputs': safeSerialize(outputs, 5000),
      'visor.snapshot.memory': safeSerialize(memory, 5000),
      'visor.snapshot.timestamp': new Date().toISOString(),
    });
  } catch (err) {
    span.setAttribute('visor.snapshot.error', String(err));
  }
}
