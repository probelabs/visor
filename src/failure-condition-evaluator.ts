/**
 * Failure condition evaluation engine using JEXL expressions
 */

const jexl = require('jexl');
import { ReviewSummary } from './reviewer';
import {
  FailureConditions,
  FailureCondition,
  FailureConditionContext,
  FailureConditionResult,
  FailureConditionSeverity,
} from './types/config';

/**
 * Evaluates failure conditions using JEXL expressions
 */
export class FailureConditionEvaluator {
  private jexlEngine: any;

  constructor() {
    this.jexlEngine = jexl;
    this.setupJexlExtensions();
  }

  /**
   * Setup custom JEXL extensions for array operations and utility functions
   * Designed to mirror GitHub Actions expression functions for familiarity
   */
  private setupJexlExtensions(): void {
    try {
      // GitHub Actions-like contains() function
      this.jexlEngine.addFunction('contains', (haystack: any, needle: any) => {
        if (typeof haystack === 'string') {
          return haystack.includes(String(needle));
        }
        if (Array.isArray(haystack)) {
          return haystack.includes(needle);
        }
        return false;
      });

      // GitHub Actions-like startsWith() function
      this.jexlEngine.addFunction('startsWith', (str: string, prefix: string) => {
        if (typeof str !== 'string') return false;
        return str.startsWith(prefix);
      });

      // GitHub Actions-like endsWith() function
      this.jexlEngine.addFunction('endsWith', (str: string, suffix: string) => {
        if (typeof str !== 'string') return false;
        return str.endsWith(suffix);
      });

      // GitHub Actions-like always() - always true
      this.jexlEngine.addFunction('always', () => true);

      // GitHub Actions-like success() - check if check succeeded (no critical/error issues)
      this.jexlEngine.addTransform('success', (val: any) => {
        // If called on metadata object, check for no critical issues
        if (val && typeof val === 'object' && 'criticalIssues' in val) {
          return val.criticalIssues === 0 && val.errorIssues === 0;
        }
        // Default to checking if value is truthy
        return !val || val === 0;
      });

      // GitHub Actions-like failure() - check if check failed (has critical/error issues)
      this.jexlEngine.addTransform('failure', (val: any) => {
        // If called on metadata object, check for critical issues
        if (val && typeof val === 'object' && 'criticalIssues' in val) {
          return val.criticalIssues > 0 || val.errorIssues > 0;
        }
        // Default to checking if value indicates failure
        return Boolean(val);
      });

      // Also add as functions for standalone use
      this.jexlEngine.addFunction('success', () => {
        // This will be used in context: metadata|success()
        return false; // Requires context via transform
      });

      this.jexlEngine.addFunction('failure', () => {
        // This will be used in context: metadata|failure()
        return false; // Requires context via transform
      });

      // Custom helper: check if any issue matches criteria (more intuitive than array filters)
      this.jexlEngine.addFunction('hasIssue', (issues: any[], field: string, value: any) => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => issue[field] === value);
      });

      // Custom helper: count matching issues
      this.jexlEngine.addFunction('countIssues', (issues: any[], field: string, value: any) => {
        if (!Array.isArray(issues)) return 0;
        return issues.filter(issue => issue[field] === value).length;
      });

      // Custom helper: check if any file path contains text
      this.jexlEngine.addFunction('hasFileMatching', (issues: any[], pattern: string) => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => issue.file && issue.file.includes(pattern));
      });

      // Helper function to get array length (JEXL doesn't support .length natively)
      this.jexlEngine.addFunction('length', (arr: any) => {
        if (Array.isArray(arr)) return arr.length;
        if (typeof arr === 'string') return arr.length;
        if (arr && typeof arr === 'object') return Object.keys(arr).length;
        return 0;
      });

      // Deprecated functions for backward compatibility
      this.jexlEngine.addFunction('hasIssueWith', (issues: any[], field: string, value: any) => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => issue[field] === value);
      });

      this.jexlEngine.addFunction('hasSuggestion', (suggestions: string[], text: string) => {
        if (!Array.isArray(suggestions)) return false;
        return suggestions.some(s => s.toLowerCase().includes(text.toLowerCase()));
      });

      this.jexlEngine.addFunction('hasFileWith', (issues: any[], text: string) => {
        if (!Array.isArray(issues)) return false;
        return issues.some(issue => issue.file && issue.file.includes(text));
      });
    } catch {
      // Fallback if addFunction is not available - use basic JEXL expressions only
      console.warn('JEXL extensions not available, using basic expressions only');
    }
  }

  /**
   * Evaluate simple fail_if condition
   */
  async evaluateSimpleCondition(
    checkName: string,
    checkSchema: string,
    checkGroup: string,
    reviewSummary: ReviewSummary,
    expression: string
  ): Promise<boolean> {
    const context = this.buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary);

    try {
      const result = await this.jexlEngine.eval(expression, context);
      return Boolean(result);
    } catch (error) {
      console.warn(`Failed to evaluate fail_if expression: ${error}`);
      return false; // Don't fail on evaluation errors
    }
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
      environment?: Record<string, any>;
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

      // Event context
      event: contextData?.event || 'manual',

      // Environment variables
      env: contextData?.environment || {},

      // Previous check results (raw outputs for full access)
      outputs: contextData?.previousResults
        ? Object.fromEntries(Array.from(contextData.previousResults.entries()))
        : {},

      // Utility metadata
      metadata: {
        checkName,
        hasChanges: (contextData?.filesChanged?.length || 0) > 0,
        branch: contextData?.branch || 'unknown',
        event: contextData?.event || 'manual',
      },
    };

    try {
      const result = await this.jexlEngine.eval(expression, context);
      return Boolean(result);
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
    checkConditions?: FailureConditions
  ): Promise<FailureConditionResult[]> {
    const context = this.buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary);

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
      const result = await this.jexlEngine.eval(expression, context);
      const failed = Boolean(result);

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
        `JEXL evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Extract the JEXL expression from a failure condition
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
   * Build the evaluation context for JEXL expressions
   */
  private buildEvaluationContext(
    checkName: string,
    checkSchema: string,
    checkGroup: string,
    reviewSummary: ReviewSummary
  ): FailureConditionContext {
    const { issues, suggestions, debug } = reviewSummary;

    // Calculate aggregated metadata
    const totalIssues = issues.length;
    const criticalIssues = issues.filter(i => i.severity === 'critical').length;
    const errorIssues = issues.filter(i => i.severity === 'error').length;
    const warningIssues = issues.filter(i => i.severity === 'warning').length;
    const infoIssues = issues.filter(i => i.severity === 'info').length;

    const context: FailureConditionContext = {
      issues: issues.map(issue => ({
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
      suggestions,
      metadata: {
        checkName,
        schema: checkSchema,
        group: checkGroup,
        totalIssues,
        criticalIssues,
        errorIssues,
        warningIssues,
        infoIssues,
      },
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
      sections.push(`❌ **Error conditions (${grouped.error.length}):**`);
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
