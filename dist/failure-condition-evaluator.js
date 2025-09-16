"use strict";
/**
 * Failure condition evaluation engine using SandboxJS for secure expression evaluation
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FailureConditionEvaluator = void 0;
const sandboxjs_1 = __importDefault(require("@nyariv/sandboxjs"));
/**
 * Evaluates failure conditions using SandboxJS for secure evaluation
 */
class FailureConditionEvaluator {
    sandbox;
    constructor() {
        this.sandbox = this.createSecureSandbox();
    }
    /**
     * Create a secure sandbox with whitelisted functions and globals
     */
    createSecureSandbox() {
        // Start with safe globals and prototypes
        const globals = {
            ...sandboxjs_1.default.SAFE_GLOBALS,
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
        const prototypeWhitelist = new Map(sandboxjs_1.default.SAFE_PROTOTYPES);
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
        return new sandboxjs_1.default({
            globals,
            prototypeWhitelist,
        });
    }
    /**
     * Evaluate simple fail_if condition
     */
    async evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, expression, previousOutputs) {
        const context = this.buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary, previousOutputs);
        try {
            return this.evaluateExpression(expression, context);
        }
        catch (error) {
            console.warn(`Failed to evaluate fail_if expression: ${error}`);
            return false; // Don't fail on evaluation errors
        }
    }
    /**
     * Evaluate if condition to determine whether a check should run
     */
    async evaluateIfCondition(checkName, expression, contextData) {
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
            return this.evaluateExpression(expression, context);
        }
        catch (error) {
            console.warn(`Failed to evaluate if expression for check '${checkName}': ${error}`);
            // Default to running the check if evaluation fails
            return true;
        }
    }
    /**
     * Evaluate all failure conditions for a check result
     */
    async evaluateConditions(checkName, checkSchema, checkGroup, reviewSummary, globalConditions, checkConditions, previousOutputs) {
        const context = this.buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary, previousOutputs);
        const results = [];
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
            const filteredResults = results.filter(result => !overriddenConditions.has(result.conditionName));
            results.length = 0;
            results.push(...filteredResults, ...checkResults);
        }
        return results;
    }
    /**
     * Evaluate a set of failure conditions
     */
    async evaluateConditionSet(conditions, context, source) {
        const results = [];
        for (const [conditionName, condition] of Object.entries(conditions)) {
            try {
                const result = await this.evaluateSingleCondition(conditionName, condition, context);
                results.push(result);
            }
            catch (error) {
                // If evaluation fails, create an error result
                results.push({
                    conditionName,
                    failed: false,
                    expression: this.extractExpression(condition),
                    severity: 'error',
                    haltExecution: false,
                    error: `Failed to evaluate ${source} condition '${conditionName}': ${error instanceof Error ? error.message : String(error)}`,
                });
            }
        }
        return results;
    }
    /**
     * Evaluate a single failure condition
     */
    async evaluateSingleCondition(conditionName, condition, context) {
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
        }
        catch (error) {
            throw new Error(`Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    /**
     * Secure expression evaluation using SandboxJS
     * Supports the same GitHub Actions-style functions as the previous implementation
     */
    evaluateExpression(condition, context) {
        try {
            // Helper functions for GitHub Actions-style expressions
            const contains = (searchString, searchValue) => String(searchString).toLowerCase().includes(String(searchValue).toLowerCase());
            const startsWith = (searchString, searchValue) => String(searchString).toLowerCase().startsWith(String(searchValue).toLowerCase());
            const endsWith = (searchString, searchValue) => String(searchString).toLowerCase().endsWith(String(searchValue).toLowerCase());
            const length = (value) => {
                if (typeof value === 'string' || Array.isArray(value)) {
                    return value.length;
                }
                if (value && typeof value === 'object') {
                    return Object.keys(value).length;
                }
                return 0;
            };
            const always = () => true;
            const success = () => true;
            const failure = () => false;
            // Helper functions for array operations
            const hasIssue = (issues, field, value) => {
                if (!Array.isArray(issues))
                    return false;
                return issues.some(issue => issue[field] === value);
            };
            const countIssues = (issues, field, value) => {
                if (!Array.isArray(issues))
                    return 0;
                return issues.filter(issue => issue[field] === value).length;
            };
            const hasFileMatching = (issues, pattern) => {
                if (!Array.isArray(issues))
                    return false;
                return issues.some(issue => issue.file && issue.file.includes(pattern));
            };
            const hasSuggestion = (suggestions, text) => {
                if (!Array.isArray(suggestions))
                    return false;
                return suggestions.some(s => s.toLowerCase().includes(text.toLowerCase()));
            };
            // Backward compatibility aliases
            const hasIssueWith = hasIssue;
            const hasFileWith = hasFileMatching;
            // Extract context variables
            const output = context.output || {};
            const issues = output.issues || [];
            const suggestions = output.suggestions || [];
            // Backward compatibility: provide metadata for transition period
            // TODO: Remove after all configurations are updated
            const metadata = context.metadata || {
                checkName: context.checkName || '',
                schema: context.schema || '',
                group: context.group || '',
                criticalIssues: issues.filter((i) => i.severity === 'critical').length,
                errorIssues: issues.filter((i) => i.severity === 'error').length,
                warningIssues: issues.filter((i) => i.severity === 'warning').length,
                infoIssues: issues.filter((i) => i.severity === 'info').length,
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
            const debug = context.debug || null;
            // Create scope with all context variables and helper functions
            const scope = {
                // Primary context variables
                output,
                outputs,
                debug,
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
                hasIssue,
                countIssues,
                hasFileMatching,
                hasSuggestion,
                hasIssueWith,
                hasFileWith,
            };
            // Compile and execute the expression in the sandbox
            const exec = this.sandbox.compile(`return (${condition.trim()});`);
            const result = exec(scope).run();
            // Ensure we return a boolean
            return Boolean(result);
        }
        catch (error) {
            console.error('❌ Failed to evaluate expression:', condition, error);
            // Re-throw the error so it can be caught at a higher level for error reporting
            throw error;
        }
    }
    /**
     * Extract the expression from a failure condition
     */
    extractExpression(condition) {
        if (typeof condition === 'string') {
            return condition;
        }
        return condition.condition;
    }
    /**
     * Extract configuration from a failure condition
     */
    extractConditionConfig(condition) {
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
    buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary, previousOutputs) {
        const { issues, suggestions, debug } = reviewSummary;
        const context = {
            output: {
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
                // Include additional schema-specific data from reviewSummary
                ...reviewSummary, // Pass through any additional fields
            },
            outputs: previousOutputs || {},
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
    /**
     * Check if any failure condition requires halting execution
     */
    static shouldHaltExecution(results) {
        return results.some(result => result.failed && result.haltExecution);
    }
    /**
     * Get all failed conditions
     */
    static getFailedConditions(results) {
        return results.filter(result => result.failed);
    }
    /**
     * Group results by severity
     */
    static groupResultsBySeverity(results) {
        return {
            error: results.filter(r => r.severity === 'error'),
            warning: results.filter(r => r.severity === 'warning'),
            info: results.filter(r => r.severity === 'info'),
        };
    }
    /**
     * Format results for display
     */
    static formatResults(results) {
        const failed = FailureConditionEvaluator.getFailedConditions(results);
        if (failed.length === 0) {
            return '✅ All failure conditions passed';
        }
        const grouped = FailureConditionEvaluator.groupResultsBySeverity(failed);
        const sections = [];
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
exports.FailureConditionEvaluator = FailureConditionEvaluator;
//# sourceMappingURL=failure-condition-evaluator.js.map