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
export declare function extractIssuesFromOutput(output: unknown, defaultRuleId?: string): {
    issues: ReviewIssue[];
    remainingOutput: unknown;
} | null;
/**
 * Normalize an array of issues. Returns null if any element cannot be normalized.
 */
export declare function normalizeIssueArray(values: unknown[], defaultRuleId?: string): ReviewIssue[] | null;
/**
 * Normalize a single issue from raw data.
 * Accepts various field aliases (message/text/description, severity/level/priority, etc.)
 */
export declare function normalizeIssue(raw: unknown, defaultRuleId?: string): ReviewIssue | null;
export declare function toTrimmedString(value: unknown): string | null;
export declare function toNumber(value: unknown): number | null;
//# sourceMappingURL=issue-normalizer.d.ts.map