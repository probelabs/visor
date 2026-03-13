/**
 * Shared issue normalization utilities.
 *
 * Used by MCP, UTCP, and command providers to extract and normalize
 * ReviewIssue objects from tool/command output.
 */
import { ReviewIssue } from '../reviewer';

/**
 * Extract issues from tool output.
 * Handles: JSON strings, arrays of issues, objects with `issues` property, single issue objects.
 */
export function extractIssuesFromOutput(
  output: unknown,
  defaultRuleId?: string
): { issues: ReviewIssue[]; remainingOutput: unknown } | null {
  if (output === null || output === undefined) {
    return null;
  }

  // If output is a string, try to parse as JSON
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output);
      return extractIssuesFromOutput(parsed, defaultRuleId);
    } catch {
      return null;
    }
  }

  // If output is an array of issues
  if (Array.isArray(output)) {
    const issues = normalizeIssueArray(output, defaultRuleId);
    if (issues) {
      return { issues, remainingOutput: undefined };
    }
    return null;
  }

  // If output is an object with issues property
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;

    if (Array.isArray(record.issues)) {
      const issues = normalizeIssueArray(record.issues, defaultRuleId);
      if (!issues) {
        return null;
      }

      const remaining = { ...record };
      delete (remaining as { issues?: unknown }).issues;

      return {
        issues,
        remainingOutput: Object.keys(remaining).length > 0 ? remaining : undefined,
      };
    }

    // Check if output itself is a single issue
    const singleIssue = normalizeIssue(record, defaultRuleId);
    if (singleIssue) {
      return { issues: [singleIssue], remainingOutput: undefined };
    }
  }

  return null;
}

/**
 * Normalize an array of issues. Returns null if any element cannot be normalized.
 */
export function normalizeIssueArray(
  values: unknown[],
  defaultRuleId?: string
): ReviewIssue[] | null {
  const normalized: ReviewIssue[] = [];
  for (const value of values) {
    const issue = normalizeIssue(value, defaultRuleId);
    if (!issue) {
      return null;
    }
    normalized.push(issue);
  }
  return normalized;
}

/**
 * Normalize a single issue from raw data.
 * Accepts various field aliases (message/text/description, severity/level/priority, etc.)
 */
export function normalizeIssue(raw: unknown, defaultRuleId = 'tool'): ReviewIssue | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const data = raw as Record<string, unknown>;

  const message = toTrimmedString(data.message || data.text || data.description || data.summary);
  if (!message) {
    return null;
  }

  const allowedSeverities = new Set(['info', 'warning', 'error', 'critical']);
  const severityRaw = toTrimmedString(data.severity || data.level || data.priority);
  let severity: ReviewIssue['severity'] = 'warning';
  if (severityRaw) {
    const lower = severityRaw.toLowerCase();
    if (allowedSeverities.has(lower)) {
      severity = lower as ReviewIssue['severity'];
    }
  }

  const allowedCategories = new Set(['security', 'performance', 'style', 'logic', 'documentation']);
  const categoryRaw = toTrimmedString(data.category || data.type || data.group);
  let category: ReviewIssue['category'] = 'logic';
  if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
    category = categoryRaw.toLowerCase() as ReviewIssue['category'];
  }

  const file = toTrimmedString(data.file || data.path || data.filename) || 'system';
  const line = toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
  const endLine = toNumber(data.endLine || data.end_line || data.stopLine);
  const suggestion = toTrimmedString(data.suggestion);
  const replacement = toTrimmedString(data.replacement);
  const ruleId =
    toTrimmedString(data.ruleId || data.rule || data.id || data.check) || defaultRuleId;

  return {
    file,
    line,
    endLine: endLine ?? undefined,
    ruleId,
    message,
    severity,
    category,
    suggestion: suggestion || undefined,
    replacement: replacement || undefined,
  };
}

export function toTrimmedString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value !== null && value !== undefined && typeof value.toString === 'function') {
    const converted = String(value).trim();
    return converted.length > 0 ? converted : null;
  }
  return null;
}

export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const num = Number(value);
  if (Number.isFinite(num)) {
    return Math.trunc(num);
  }
  return null;
}
