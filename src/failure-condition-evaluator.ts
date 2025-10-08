/**
 * Failure condition evaluation engine using SandboxJS for secure expression evaluation
 */

import { ReviewSummary } from './reviewer';
import {
  FailureConditions,
  FailureCondition,
  FailureConditionContext,
  FailureConditionResult,
  FailureConditionSeverity,
} from './types/config';
import Sandbox from '@nyariv/sandboxjs';

/**
 * Evaluates failure conditions using SandboxJS for secure evaluation
 */
export class FailureConditionEvaluator {
  private sandbox?: Sandbox;

  constructor() {}

  /**
   * Create a secure sandbox with whitelisted functions and globals
   */
  private createSecureSandbox(): Sandbox {
    // Start with safe globals and prototypes
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      // Allow Math for calculations
      Math,
      // Allow console for debugging (in controlled environment)
      console: {
        log: console.log,
        warn: console.warn,
        error: console.error,
      },
    };

    // Create prototype whitelist - use safe defaults
    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);

    // Explicitly allow array methods that we need
    const arrayMethods = new Set([
      'some',
      'every',
      'filter',
      'map',
      'reduce',
      'find',
      'includes',
      'indexOf',
      'length',
      'slice',
      'concat',
      'join',
    ]);
    prototypeWhitelist.set(Array.prototype, arrayMethods);

    // Allow string methods
    const stringMethods = new Set([
      'toLowerCase',
      'toUpperCase',
      'includes',
      'indexOf',
      'startsWith',
      'endsWith',
      'slice',
      'substring',
      'length',
      'trim',
      'split',
      'replace',
    ]);
    prototypeWhitelist.set(String.prototype, stringMethods);

    // Allow basic object methods
    const objectMethods = new Set(['hasOwnProperty', 'toString', 'valueOf']);
    prototypeWhitelist.set(Object.prototype, objectMethods);

    return new Sandbox({
      globals,
      prototypeWhitelist,
    });
  }

  /**
   * Evaluate simple fail_if condition
   */
  async evaluateSimpleCondition(
    checkName: string,
    checkSchema: string,
    checkGroup: string,
    reviewSummary: ReviewSummary,
    expression: string,
    previousOutputs?: Record<string, ReviewSummary>
  ): Promise<boolean> {
    const context = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs
    );

    try {
      const res = this.evaluateExpression(expression, context);
      return res;
    } catch (error) {
      console.warn(`Failed to evaluate fail_if expression: ${error}`);
      return false; // Don't fail on evaluation errors
    }
  }

  /**
   * Determine if the event is related to pull requests
   */
  private determineIfPullRequest(eventType?: string): boolean {
    if (!eventType) return false;

    const prEvents = ['pr_opened', 'pr_updated', 'pr_closed', 'pull_request'];
    return prEvents.includes(eventType) || eventType.startsWith('pr_');
  }

  /**
   * Determine if the event is related to issues
   */
  private determineIfIssue(eventType?: string): boolean {
    if (!eventType) return false;

    const issueEvents = ['issue_opened', 'issue_comment', 'issues'];
    return issueEvents.includes(eventType) || eventType.startsWith('issue_');
  }

  /**
   * Evaluate if condition to determine whether a check should run
   */
  async evaluateIfCondition(
    checkName: string,
    expression: string,
    contextData?: {
      branch?: string;
      baseBranch?: string;
      filesChanged?: string[];
      event?: string;
      environment?: Record<string, string>;
      previousResults?: Map<string, ReviewSummary>;
    }
  ): Promise<boolean> {
    // Build context for if evaluation
    const context = {
      // Check metadata
      checkName,

      // Git context
      branch: contextData?.branch || 'unknown',
      baseBranch: contextData?.baseBranch || 'main',
      filesChanged: contextData?.filesChanged || [],
      filesCount: contextData?.filesChanged?.length || 0,

      // GitHub event context
      event: {
        event_name: contextData?.event || 'manual',
        action: undefined, // Would be populated from actual GitHub context
        repository: undefined, // Would be populated from actual GitHub context
      },

      // Environment variables
      env: contextData?.environment || {},

      // Previous check results (unwrap output field like templates do)
      outputs: contextData?.previousResults
        ? (() => {
            const outputs: Record<string, unknown> = {};
            for (const [checkName, result] of contextData.previousResults) {
              // If the result has a direct output field, use it directly
              // Otherwise, expose the entire result as-is
              const summary = result as ReviewSummary & { output?: unknown };
              outputs[checkName] = summary.output !== undefined ? summary.output : summary;
            }
            return outputs;
          })()
        : {},

      // Required output property (empty for if conditions)
      output: {
        issues: [],
      },

      // Utility metadata
      metadata: {
        checkName,
        schema: '',
        group: '',
        criticalIssues: 0,
        errorIssues: 0,
        warningIssues: 0,
        infoIssues: 0,
        totalIssues: 0,
        hasChanges: (contextData?.filesChanged?.length || 0) > 0,
        branch: contextData?.branch || 'unknown',
        event: contextData?.event || 'manual',
      },
    };

    try {
      return this.evaluateExpression(expression, context);
    } catch (error) {
      console.warn(`Failed to evaluate if expression for check '${checkName}': ${error}`);
      // Default to running the check if evaluation fails
      return true;
    }
  }

  /**
   * Evaluate all failure conditions for a check result
   */
  async evaluateConditions(
    checkName: string,
    checkSchema: string,
    checkGroup: string,
    reviewSummary: ReviewSummary,
    globalConditions?: FailureConditions,
    checkConditions?: FailureConditions,
    previousOutputs?: Record<string, ReviewSummary>
  ): Promise<FailureConditionResult[]> {
    const context = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs
    );

    const results: FailureConditionResult[] = [];

    // Evaluate global conditions first
    if (globalConditions) {
      const globalResults = await this.evaluateConditionSet(globalConditions, context, 'global');
      results.push(...globalResults);
    }

    // Evaluate check-specific conditions (these override global ones with same name)
    if (checkConditions) {
      const checkResults = await this.evaluateConditionSet(checkConditions, context, 'check');

      // Remove global conditions that are overridden by check-specific ones
      const overriddenConditions = new Set(Object.keys(checkConditions));
      const filteredResults = results.filter(
        result => !overriddenConditions.has(result.conditionName)
      );

      results.length = 0;
      results.push(...filteredResults, ...checkResults);
    }

    return results;
  }

  /**
   * Evaluate a set of failure conditions
   */
  private async evaluateConditionSet(
    conditions: FailureConditions,
    context: FailureConditionContext,
    source: 'global' | 'check'
  ): Promise<FailureConditionResult[]> {
    const results: FailureConditionResult[] = [];

    for (const [conditionName, condition] of Object.entries(conditions)) {
      try {
        const result = await this.evaluateSingleCondition(conditionName, condition, context);
        results.push(result);
      } catch (error) {
        // If evaluation fails, create an error result
        results.push({
          conditionName,
          failed: false,
          expression: this.extractExpression(condition),
          severity: 'error',
          haltExecution: false,
          error: `Failed to evaluate ${source} condition '${conditionName}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    return results;
  }

  /**
   * Evaluate a single failure condition
   */
  private async evaluateSingleCondition(
    conditionName: string,
    condition: FailureCondition,
    context: FailureConditionContext
  ): Promise<FailureConditionResult> {
    const expression = this.extractExpression(condition);
    const config = this.extractConditionConfig(condition);

    try {
      const failed = this.evaluateExpression(expression, context);

      return {
        conditionName,
        failed,
        expression,
        message: config.message,
        severity: config.severity || 'error',
        haltExecution: config.halt_execution || false,
      };
    } catch (error) {
      throw new Error(
        `Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Secure expression evaluation using SandboxJS
   * Supports the same GitHub Actions-style functions as the previous implementation
   */
  private evaluateExpression(condition: string, context: FailureConditionContext): boolean {
    try {
      // Normalize multi-line or semicolon-separated expressions.
      // Allows writing debug statements on separate lines, e.g.:
      //   log("start")
      //   log(outputs)
      //   outputs["fetch-tickets"].issueType === 'Bug'
      // We convert to a single expression using the comma operator so the
      // final expression determines the boolean result.
      const normalize = (expr: string): string => {
        const trimmed = expr.trim();
        // If it's already a single-line expression without semicolons, keep it.
        if (!/[\n;]/.test(trimmed)) return trimmed;

        // Split on newlines/semicolons, drop empty and comment-only lines.
        const parts = trimmed
          .split(/[\n;]+/)
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.startsWith('//'));

        if (parts.length === 0) return 'true';

        // Support an explicit return in the last statement.
        const lastRaw = parts.pop() as string;
        const last = lastRaw.replace(/^return\s+/i, '').trim();

        // Join leading statements with comma operator; last expression returns value.
        if (parts.length === 0) return last;
        return `(${parts.join(', ')}, ${last})`;
      };

      // note: normalization happens later only if raw compilation fails
      // Helper functions for GitHub Actions-style expressions
      const contains = (searchString: string, searchValue: string): boolean =>
        String(searchString).toLowerCase().includes(String(searchValue).toLowerCase());

      const startsWith = (searchString: string, searchValue: string): boolean =>
        String(searchString).toLowerCase().startsWith(String(searchValue).toLowerCase());

      const endsWith = (searchString: string, searchValue: string): boolean =>
        String(searchString).toLowerCase().endsWith(String(searchValue).toLowerCase());

      const length = (value: string | unknown[] | Record<string, unknown>): number => {
        if (typeof value === 'string' || Array.isArray(value)) {
          return value.length;
        }
        if (value && typeof value === 'object') {
          return Object.keys(value).length;
        }
        return 0;
      };

      const always = (): boolean => true;
      const success = (): boolean => true;
      const failure = (): boolean => false;

      // Debug logging function for printing to console
      const log = (...args: unknown[]): void => {
        console.log('🔍 Debug:', ...args);
      };

      // Helper functions for array operations
      const hasIssue = (issues: unknown[], field: string, value: unknown): boolean => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => (issue as Record<string, unknown>)[field] === value);
      };

      const countIssues = (issues: unknown[], field: string, value: unknown): number => {
        if (!Array.isArray(issues)) return 0;
        return issues.filter(issue => (issue as Record<string, unknown>)[field] === value).length;
      };

      const hasFileMatching = (issues: unknown[], pattern: string): boolean => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => (issue as { file?: string }).file?.includes(pattern));
      };

      const hasSuggestion = (suggestions: string[], text: string): boolean => {
        if (!Array.isArray(suggestions)) return false;
        return suggestions.some(s => s.toLowerCase().includes(text.toLowerCase()));
      };

      // Backward compatibility aliases
      const hasIssueWith = hasIssue;
      const hasFileWith = hasFileMatching;

      // Extract context variables
      const output = context.output || {};
      const issues = output.issues || [];
      const suggestions: string[] = [];

      // Backward compatibility: provide metadata for transition period
      // TODO: Remove after all configurations are updated
      const metadata = context.metadata || {
        checkName: context.checkName || '',
        schema: context.schema || '',
        group: context.group || '',
        criticalIssues: issues.filter((i: { severity?: string }) => i.severity === 'critical')
          .length,
        errorIssues: issues.filter((i: { severity?: string }) => i.severity === 'error').length,
        warningIssues: issues.filter((i: { severity?: string }) => i.severity === 'warning').length,
        infoIssues: issues.filter((i: { severity?: string }) => i.severity === 'info').length,
        totalIssues: issues.length,
        hasChanges: context.hasChanges || false,
      };

      // Legacy variables for backward compatibility
      const criticalIssues = metadata.criticalIssues;
      const errorIssues = metadata.errorIssues;
      const totalIssues = metadata.totalIssues;
      const warningIssues = metadata.warningIssues;
      const infoIssues = metadata.infoIssues;

      // Additional context for 'if' conditions and some failure conditions
      const checkName = context.checkName || '';
      const schema = context.schema || '';
      const group = context.group || '';
      const branch = context.branch || 'unknown';
      const baseBranch = context.baseBranch || 'main';
      const filesChanged = context.filesChanged || [];
      const filesCount = context.filesCount || 0;
      const event = context.event || 'manual';
      const env = context.env || {};
      const outputs = context.outputs || {};
      const debugData = context.debug || null;

      // Create scope with all context variables and helper functions
      const scope = {
        // Primary context variables
        output,
        outputs,
        debug: debugData,
        // Legacy compatibility variables
        issues,
        suggestions,
        metadata,
        criticalIssues,
        errorIssues,
        totalIssues,
        warningIssues,
        infoIssues,
        // If condition context
        checkName,
        schema,
        group,
        branch,
        baseBranch,
        filesChanged,
        filesCount,
        event,
        env,
        // Helper functions
        contains,
        startsWith,
        endsWith,
        length,
        always,
        success,
        failure,
        log,
        hasIssue,
        countIssues,
        hasFileMatching,
        hasSuggestion,
        hasIssueWith,
        hasFileWith,
      };

      // Compile and execute the expression in the sandbox
      const raw = condition.trim();
      if (!this.sandbox) {
        this.sandbox = this.createSecureSandbox();
      }
      let exec: ReturnType<typeof this.sandbox.compile>;
      try {
        // Try compiling the raw expression as-is first (supports multi-line logical expressions)
        exec = this.sandbox.compile(`return (${raw});`);
      } catch {
        // Fallback: normalize multi-line statements into a comma-chain expression
        const normalizedExpr = normalize(condition);
        exec = this.sandbox.compile(`return (${normalizedExpr});`);
      }
      const result = exec(scope).run();

      // Ensure we return a boolean
      return Boolean(result);
    } catch (error) {
      console.error('❌ Failed to evaluate expression:', condition, error);
      // Re-throw the error so it can be caught at a higher level for error reporting
      throw error;
    }
  }

  /**
   * Extract the expression from a failure condition
   */
  private extractExpression(condition: FailureCondition): string {
    if (typeof condition === 'string') {
      return condition;
    }
    return condition.condition;
  }

  /**
   * Extract configuration from a failure condition
   */
  private extractConditionConfig(condition: FailureCondition): {
    message?: string;
    severity?: FailureConditionSeverity;
    halt_execution?: boolean;
  } {
    if (typeof condition === 'string') {
      return {};
    }
    return {
      message: condition.message,
      severity: condition.severity,
      halt_execution: condition.halt_execution,
    };
  }

  /**
   * Build the evaluation context for expressions
   */
  private buildEvaluationContext(
    checkName: string,
    checkSchema: string,
    checkGroup: string,
    reviewSummary: ReviewSummary,
    previousOutputs?: Record<string, ReviewSummary>
  ): FailureConditionContext {
    const { issues, debug } = reviewSummary;
    const reviewSummaryWithOutput = reviewSummary as ReviewSummary & { output?: unknown };

    // Extract output field to avoid nesting (output.output)
    const {
      output: extractedOutput,
      // Exclude issues from otherFields since we handle it separately
      issues: _issues, // eslint-disable-line @typescript-eslint/no-unused-vars
      ...otherFields
    } = reviewSummaryWithOutput as any;

    // Build output object with safety for array-based outputs (forEach aggregation)
    const aggregatedOutput: Record<string, unknown> = {
      issues: (issues || []).map(issue => ({
        file: issue.file,
        line: issue.line,
        endLine: issue.endLine,
        ruleId: issue.ruleId,
        message: issue.message,
        severity: issue.severity,
        category: issue.category,
        group: issue.group,
        schema: issue.schema,
        suggestion: issue.suggestion,
        replacement: issue.replacement,
      })),
      // Include additional schema-specific data from reviewSummary
      ...otherFields,
    };

    if (Array.isArray(extractedOutput)) {
      // Preserve items array and lift common flags for convenience (e.g., output.error)
      aggregatedOutput.items = extractedOutput;
      const anyError = extractedOutput.find(
        it => it && typeof it === 'object' && (it as Record<string, unknown>).error
      ) as Record<string, unknown> | undefined;
      if (anyError && anyError.error !== undefined) {
        aggregatedOutput.error = anyError.error;
      }
    } else if (extractedOutput && typeof extractedOutput === 'object') {
      Object.assign(aggregatedOutput, extractedOutput as Record<string, unknown>);
    }

    // If output is a string, try to parse JSON (full or from end) to enrich context,
    // and also derive common boolean flags generically (e.g., key:true/false) for fail_if usage.
    try {
      if (typeof extractedOutput === 'string') {
        const parsed =
          this.tryExtractJsonFromEnd(extractedOutput) ??
          (() => {
            try {
              return JSON.parse(extractedOutput);
            } catch {
              return null;
            }
          })();
        if (parsed !== null) {
          if (Array.isArray(parsed)) {
            (aggregatedOutput as any).items = parsed;
          } else if (typeof parsed === 'object') {
            Object.assign(aggregatedOutput, parsed as Record<string, unknown>);
          }
        }
        // Generic boolean key extraction for simple text outputs (no special provider cases)
        const lower = extractedOutput.toLowerCase();
        const boolFrom = (key: string): boolean | null => {
          const reTrue = new RegExp(
            `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*true(?:[^a-z0-9_]|$)`
          );
          const reFalse = new RegExp(
            `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*false(?:[^a-z0-9_]|$)`
          );
          if (reTrue.test(lower)) return true;
          if (reFalse.test(lower)) return false;
          return null;
        };
        const keys = ['error'];
        for (const k of keys) {
          const v = boolFrom(k);
          if (v !== null && (aggregatedOutput as any)[k] === undefined) {
            (aggregatedOutput as any)[k] = v;
          }
        }
      }
    } catch {}

    // Try to parse JSON from content as a last resort when no structured output is present
    try {
      const rsAny = reviewSummaryWithOutput as any;
      const hasStructuredOutput = extractedOutput !== undefined && extractedOutput !== null;
      if (!hasStructuredOutput && typeof rsAny?.content === 'string') {
        const parsedFromContent = this.tryExtractJsonFromEnd(rsAny.content);
        if (parsedFromContent !== null && parsedFromContent !== undefined) {
          if (Array.isArray(parsedFromContent)) {
            (aggregatedOutput as any).items = parsedFromContent;
          } else if (typeof parsedFromContent === 'object') {
            Object.assign(aggregatedOutput, parsedFromContent as Record<string, unknown>);
          }
        }
      }
    } catch {}

    const context: FailureConditionContext = {
      output: aggregatedOutput,
      outputs: (() => {
        if (!previousOutputs) return {};
        const outputs: Record<string, unknown> = {};
        for (const [checkName, result] of Object.entries(previousOutputs)) {
          // If the result has a direct output field, use it directly
          // Otherwise, expose the entire result as-is
          const summary = result as ReviewSummary & { output?: unknown };
          outputs[checkName] = summary.output !== undefined ? summary.output : summary;
        }
        return outputs;
      })(),
      // Add basic context info for failure conditions
      checkName: checkName,
      schema: checkSchema,
      group: checkGroup,
    };

    // Add debug information if available
    if (debug) {
      context.debug = {
        errors: debug.errors || [],
        processingTime: debug.processingTime || 0,
        provider: debug.provider || 'unknown',
        model: debug.model || 'unknown',
      };
    }

    return context;
  }

  // Minimal JSON-from-end extractor for fail_if context fallback
  private tryExtractJsonFromEnd(text: string): unknown | null {
    try {
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          const candidate = lines.slice(i).join('\n').trim();
          if (
            (candidate.startsWith('{') && candidate.endsWith('}')) ||
            (candidate.startsWith('[') && candidate.endsWith(']'))
          ) {
            return JSON.parse(candidate);
          }
        }
      }
    } catch {}
    return null;
  }

  /**
   * Check if any failure condition requires halting execution
   */
  static shouldHaltExecution(results: FailureConditionResult[]): boolean {
    return results.some(result => result.failed && result.haltExecution);
  }

  /**
   * Get all failed conditions
   */
  static getFailedConditions(results: FailureConditionResult[]): FailureConditionResult[] {
    return results.filter(result => result.failed);
  }

  /**
   * Group results by severity
   */
  static groupResultsBySeverity(results: FailureConditionResult[]): {
    error: FailureConditionResult[];
    warning: FailureConditionResult[];
    info: FailureConditionResult[];
  } {
    return {
      // Only 'error' severity now (no backward compatibility needed here as this is internal)
      error: results.filter(r => r.severity === 'error'),
      warning: results.filter(r => r.severity === 'warning'),
      info: results.filter(r => r.severity === 'info'),
    };
  }

  /**
   * Format results for display
   */
  static formatResults(results: FailureConditionResult[]): string {
    const failed = FailureConditionEvaluator.getFailedConditions(results);

    if (failed.length === 0) {
      return '✅ All failure conditions passed';
    }

    const grouped = FailureConditionEvaluator.groupResultsBySeverity(failed);
    const sections: string[] = [];

    if (grouped.error.length > 0) {
      sections.push(`❌ **Error severity conditions (${grouped.error.length}):**`);
      grouped.error.forEach(result => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }

    if (grouped.warning.length > 0) {
      sections.push(`⚠️ **Warning conditions (${grouped.warning.length}):**`);
      grouped.warning.forEach(result => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }

    if (grouped.info.length > 0) {
      sections.push(`ℹ️ **Info conditions (${grouped.info.length}):**`);
      grouped.info.forEach(result => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }

    return sections.join('\n');
  }
}
