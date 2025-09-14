"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckExecutionEngine = void 0;
const reviewer_1 = require("./reviewer");
const git_repository_analyzer_1 = require("./git-repository-analyzer");
const check_provider_registry_1 = require("./providers/check-provider-registry");
const dependency_resolver_1 = require("./dependency-resolver");
const failure_condition_evaluator_1 = require("./failure-condition-evaluator");
const github_check_service_1 = require("./github-check-service");
/**
 * Filter environment variables to only include safe ones for sandbox evaluation
 */
function getSafeEnvironmentVariables() {
    const safeEnvVars = [
        'CI',
        'GITHUB_EVENT_NAME',
        'GITHUB_REPOSITORY',
        'GITHUB_REF',
        'GITHUB_SHA',
        'GITHUB_HEAD_REF',
        'GITHUB_BASE_REF',
        'GITHUB_ACTOR',
        'GITHUB_WORKFLOW',
        'GITHUB_RUN_ID',
        'GITHUB_RUN_NUMBER',
        'NODE_ENV',
    ];
    const safeEnv = {};
    for (const key of safeEnvVars) {
        if (process.env[key]) {
            safeEnv[key] = process.env[key];
        }
    }
    return safeEnv;
}
class CheckExecutionEngine {
    gitAnalyzer;
    mockOctokit;
    reviewer;
    providerRegistry;
    failureEvaluator;
    githubCheckService;
    checkRunMap;
    githubContext;
    constructor(workingDirectory) {
        this.gitAnalyzer = new git_repository_analyzer_1.GitRepositoryAnalyzer(workingDirectory);
        this.providerRegistry = check_provider_registry_1.CheckProviderRegistry.getInstance();
        this.failureEvaluator = new failure_condition_evaluator_1.FailureConditionEvaluator();
        // Create a mock Octokit instance for local analysis
        // This allows us to reuse the existing PRReviewer logic without network calls
        this.mockOctokit = this.createMockOctokit();
        this.reviewer = new reviewer_1.PRReviewer(this.mockOctokit);
    }
    /**
     * Execute checks on the local repository
     */
    async executeChecks(options) {
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        try {
            // Determine where to send log messages based on output format
            const logFn = options.outputFormat === 'json' || options.outputFormat === 'sarif'
                ? console.error
                : console.log;
            // Initialize GitHub checks if enabled
            if (options.githubChecks?.enabled && options.githubChecks.octokit) {
                await this.initializeGitHubChecks(options, logFn);
            }
            // Analyze the repository
            logFn('🔍 Analyzing local git repository...');
            const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
            if (!repositoryInfo.isGitRepository) {
                // Complete GitHub checks with error if they were initialized
                if (this.checkRunMap) {
                    await this.completeGitHubChecksWithError('Not a git repository or no changes found');
                }
                return this.createErrorResult(repositoryInfo, 'Not a git repository or no changes found', startTime, timestamp, options.checks);
            }
            // Convert to PRInfo format for compatibility with existing reviewer
            const prInfo = this.gitAnalyzer.toPRInfo(repositoryInfo);
            // Update GitHub checks to in-progress status
            if (this.checkRunMap) {
                await this.updateGitHubChecksInProgress(options);
            }
            // Execute checks using the existing PRReviewer
            logFn(`🤖 Executing checks: ${options.checks.join(', ')}`);
            const reviewSummary = await this.executeReviewChecks(prInfo, options.checks, options.timeout, options.config, options.outputFormat, options.debug);
            // Complete GitHub checks with results
            if (this.checkRunMap) {
                await this.completeGitHubChecksWithResults(reviewSummary, options);
            }
            const executionTime = Date.now() - startTime;
            // Collect debug information when debug mode is enabled
            let debugInfo;
            if (options.debug && reviewSummary.debug) {
                debugInfo = {
                    provider: reviewSummary.debug.provider,
                    model: reviewSummary.debug.model,
                    processingTime: reviewSummary.debug.processingTime,
                    parallelExecution: options.checks.length > 1,
                    checksExecuted: options.checks,
                    totalApiCalls: reviewSummary.debug.totalApiCalls || options.checks.length,
                    apiCallDetails: reviewSummary.debug.apiCallDetails,
                };
            }
            return {
                repositoryInfo,
                reviewSummary,
                executionTime,
                timestamp,
                checksExecuted: options.checks,
                debug: debugInfo,
            };
        }
        catch (error) {
            console.error('Error executing checks:', error);
            // Complete GitHub checks with error if they were initialized
            if (this.checkRunMap) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                await this.completeGitHubChecksWithError(errorMessage);
            }
            const fallbackRepositoryInfo = {
                title: 'Error during analysis',
                body: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                author: 'system',
                base: 'main',
                head: 'HEAD',
                files: [],
                totalAdditions: 0,
                totalDeletions: 0,
                isGitRepository: false,
                workingDirectory: options.workingDirectory || process.cwd(),
            };
            return this.createErrorResult(fallbackRepositoryInfo, error instanceof Error ? error.message : 'Unknown error occurred', startTime, timestamp, options.checks);
        }
    }
    /**
     * Execute review checks using parallel execution for multiple AI checks
     */
    async executeReviewChecks(prInfo, checks, timeout, config, outputFormat, debug) {
        // Determine where to send log messages based on output format
        const logFn = outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;
        logFn(`🔧 Debug: executeReviewChecks called with checks: ${JSON.stringify(checks)}`);
        logFn(`🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);
        // If we have a config with individual check definitions, use dependency-aware execution
        // Check if any of the checks have dependencies or if there are multiple checks
        const hasDependencies = config?.checks &&
            checks.some(checkName => {
                const checkConfig = config.checks[checkName];
                return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
            });
        if (config?.checks && (checks.length > 1 || hasDependencies)) {
            logFn(`🔧 Debug: Using dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies})`);
            return await this.executeDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug);
        }
        // Single check execution (existing logic)
        if (checks.length === 1) {
            logFn(`🔧 Debug: Using single check execution for: ${checks[0]}`);
            // If we have a config definition for this check, use it
            if (config?.checks?.[checks[0]]) {
                return await this.executeSingleConfiguredCheck(prInfo, checks[0], timeout, config, logFn);
            }
            // Try provider system for single checks
            if (this.providerRegistry.hasProvider(checks[0])) {
                const provider = this.providerRegistry.getProviderOrThrow(checks[0]);
                const providerConfig = {
                    type: checks[0],
                    prompt: 'all',
                    ai: timeout ? { timeout } : undefined,
                };
                const result = await provider.execute(prInfo, providerConfig);
                // Prefix issues with check name for consistent grouping
                const prefixedIssues = result.issues.map(issue => ({
                    ...issue,
                    ruleId: `${checks[0]}/${issue.ruleId}`,
                }));
                return {
                    ...result,
                    issues: prefixedIssues,
                };
            }
        }
        // Check if 'ai' provider is available for focus-based checks (legacy support)
        if (this.providerRegistry.hasProvider('ai')) {
            logFn(`🔧 Debug: Using AI provider with focus mapping`);
            const provider = this.providerRegistry.getProviderOrThrow('ai');
            let focus = 'all';
            let checkName = 'all';
            if (checks.length === 1) {
                checkName = checks[0];
                if (checks[0] === 'security' || checks[0] === 'performance' || checks[0] === 'style') {
                    focus = checks[0];
                }
            }
            else {
                // For multiple checks, combine them into 'all' focus
                focus = 'all';
            }
            const providerConfig = {
                type: 'ai',
                prompt: focus,
                focus: focus,
                ai: timeout ? { timeout } : undefined,
                // Inherit global AI provider and model settings if config is available
                ai_provider: config?.ai_provider,
                ai_model: config?.ai_model,
            };
            const result = await provider.execute(prInfo, providerConfig);
            // Prefix issues with check name for consistent grouping
            const prefixedIssues = result.issues.map(issue => ({
                ...issue,
                ruleId: `${checkName}/${issue.ruleId}`,
            }));
            return {
                ...result,
                issues: prefixedIssues,
            };
        }
        // Fallback to existing PRReviewer for backward compatibility
        logFn(`🔧 Debug: Using legacy PRReviewer fallback`);
        const focusMap = {
            security: 'security',
            performance: 'performance',
            style: 'style',
            all: 'all',
            architecture: 'all',
        };
        let focus = 'all';
        if (checks.length === 1 && focusMap[checks[0]]) {
            focus = focusMap[checks[0]];
        }
        return await this.reviewer.reviewPR('local', 'repository', 0, prInfo, {
            focus,
            format: 'table',
        });
    }
    /**
     * Execute multiple checks with dependency awareness - intelligently parallel and sequential
     */
    async executeDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug) {
        const log = logFn || console.error;
        log(`🔧 Debug: Starting dependency-aware execution of ${checks.length} checks`);
        if (!config?.checks) {
            throw new Error('Config with check definitions required for dependency-aware execution');
        }
        // Build dependency graph
        const dependencies = {};
        for (const checkName of checks) {
            const checkConfig = config.checks[checkName];
            if (checkConfig) {
                dependencies[checkName] = checkConfig.depends_on || [];
            }
            else {
                dependencies[checkName] = [];
            }
        }
        // Validate dependencies
        const validation = dependency_resolver_1.DependencyResolver.validateDependencies(checks, dependencies);
        if (!validation.valid) {
            return {
                issues: [
                    {
                        severity: 'error',
                        message: `Dependency validation failed: ${validation.errors.join(', ')}`,
                        file: '',
                        line: 0,
                        ruleId: 'dependency-validation-error',
                        category: 'logic',
                    },
                ],
                suggestions: [],
            };
        }
        // Build dependency graph
        const dependencyGraph = dependency_resolver_1.DependencyResolver.buildDependencyGraph(dependencies);
        if (dependencyGraph.hasCycles) {
            return {
                issues: [
                    {
                        severity: 'error',
                        message: `Circular dependencies detected: ${dependencyGraph.cycleNodes?.join(' -> ')}`,
                        file: '',
                        line: 0,
                        ruleId: 'circular-dependency-error',
                        category: 'logic',
                    },
                ],
                suggestions: [],
            };
        }
        // Log execution plan
        const stats = dependency_resolver_1.DependencyResolver.getExecutionStats(dependencyGraph);
        log(`🔧 Debug: Execution plan - ${stats.totalChecks} checks in ${stats.parallelLevels} levels, max parallelism: ${stats.maxParallelism}`);
        // Execute checks level by level
        const results = new Map();
        const provider = this.providerRegistry.getProviderOrThrow('ai');
        for (let levelIndex = 0; levelIndex < dependencyGraph.executionOrder.length; levelIndex++) {
            const executionGroup = dependencyGraph.executionOrder[levelIndex];
            log(`🔧 Debug: Executing level ${executionGroup.level} with ${executionGroup.parallel.length} checks in parallel`);
            // Execute all checks in this level in parallel
            const levelTasks = executionGroup.parallel.map(async (checkName) => {
                const checkConfig = config.checks[checkName];
                if (!checkConfig) {
                    return {
                        checkName,
                        error: `No configuration found for check: ${checkName}`,
                        result: null,
                    };
                }
                try {
                    log(`🔧 Debug: Starting check: ${checkName} at level ${executionGroup.level}`);
                    // Evaluate if condition to determine whether to run this check
                    if (checkConfig.if) {
                        const shouldRun = await this.failureEvaluator.evaluateIfCondition(checkName, checkConfig.if, {
                            branch: prInfo.head,
                            baseBranch: prInfo.base,
                            filesChanged: prInfo.files.map(f => f.filename),
                            event: 'manual', // TODO: Get actual event from context
                            environment: getSafeEnvironmentVariables(),
                            previousResults: results,
                        });
                        if (!shouldRun) {
                            log(`🔧 Debug: Skipping check '${checkName}' - if condition evaluated to false`);
                            return {
                                checkName,
                                error: null,
                                result: {
                                    issues: [],
                                    suggestions: [`Check '${checkName}' was skipped - condition not met`],
                                },
                            };
                        }
                    }
                    // Create provider config for this specific check
                    const providerConfig = {
                        type: 'ai',
                        prompt: checkConfig.prompt,
                        focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
                        schema: checkConfig.schema,
                        group: checkConfig.group,
                        ai: {
                            timeout: timeout || 600000,
                            debug: debug,
                            ...(checkConfig.ai || {}),
                        },
                    };
                    // Pass results from dependencies if needed
                    const dependencyResults = new Map();
                    for (const depId of checkConfig.depends_on || []) {
                        if (results.has(depId)) {
                            dependencyResults.set(depId, results.get(depId));
                        }
                    }
                    const result = await provider.execute(prInfo, providerConfig, dependencyResults);
                    log(`🔧 Debug: Completed check: ${checkName}, issues found: ${result.issues.length}`);
                    // Add group, schema, template info and timestamp to issues from config
                    const enrichedIssues = result.issues.map(issue => ({
                        ...issue,
                        ruleId: `${checkName}/${issue.ruleId}`,
                        group: checkConfig.group,
                        schema: checkConfig.schema,
                        template: checkConfig.template,
                        timestamp: Date.now(),
                    }));
                    const enrichedResult = {
                        ...result,
                        issues: enrichedIssues,
                    };
                    return {
                        checkName,
                        error: null,
                        result: enrichedResult,
                    };
                }
                catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    log(`🔧 Debug: Error in check ${checkName}: ${errorMessage}`);
                    return {
                        checkName,
                        error: errorMessage,
                        result: null,
                    };
                }
            });
            // Wait for all checks in this level to complete
            const levelResults = await Promise.allSettled(levelTasks);
            // Process results and store them for next level
            for (let i = 0; i < levelResults.length; i++) {
                const checkName = executionGroup.parallel[i];
                const result = levelResults[i];
                if (result.status === 'fulfilled' && result.value.result && !result.value.error) {
                    results.set(checkName, result.value.result);
                }
                else {
                    // Store error result for dependency tracking
                    const errorSummary = {
                        issues: [
                            {
                                file: 'system',
                                line: 0,
                                endLine: undefined,
                                ruleId: `${checkName}/error`,
                                message: result.status === 'fulfilled'
                                    ? result.value.error || 'Unknown error'
                                    : result.reason instanceof Error
                                        ? result.reason.message
                                        : String(result.reason),
                                severity: 'error',
                                category: 'logic',
                                suggestion: undefined,
                                replacement: undefined,
                            },
                        ],
                        suggestions: [],
                    };
                    results.set(checkName, errorSummary);
                }
            }
        }
        // Aggregate all results
        return this.aggregateDependencyAwareResults(results, dependencyGraph, debug);
    }
    /**
     * Execute multiple checks in parallel using Promise.allSettled (legacy method)
     */
    async executeParallelChecks(prInfo, checks, timeout, config, logFn, debug) {
        const log = logFn || console.error;
        log(`🔧 Debug: Starting parallel execution of ${checks.length} checks`);
        if (!config?.checks) {
            throw new Error('Config with check definitions required for parallel execution');
        }
        const provider = this.providerRegistry.getProviderOrThrow('ai');
        // Create individual check tasks
        const checkTasks = checks.map(async (checkName) => {
            const checkConfig = config.checks[checkName];
            if (!checkConfig) {
                log(`🔧 Debug: No config found for check: ${checkName}`);
                return {
                    checkName,
                    error: `No configuration found for check: ${checkName}`,
                    result: null,
                };
            }
            try {
                console.error(`🔧 Debug: Starting check: ${checkName} with prompt type: ${typeof checkConfig.prompt}`);
                // Evaluate if condition to determine whether to run this check
                if (checkConfig.if) {
                    const shouldRun = await this.failureEvaluator.evaluateIfCondition(checkName, checkConfig.if, {
                        branch: prInfo.head,
                        baseBranch: prInfo.base,
                        filesChanged: prInfo.files.map(f => f.filename),
                        event: 'manual', // TODO: Get actual event from context
                        environment: getSafeEnvironmentVariables(),
                        previousResults: new Map(), // No previous results in parallel execution
                    });
                    if (!shouldRun) {
                        console.error(`🔧 Debug: Skipping check '${checkName}' - if condition evaluated to false`);
                        return {
                            checkName,
                            error: null,
                            result: {
                                issues: [],
                                suggestions: [`Check '${checkName}' was skipped - condition not met`],
                            },
                        };
                    }
                }
                // Create provider config for this specific check
                const providerConfig = {
                    type: 'ai',
                    prompt: checkConfig.prompt,
                    focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
                    schema: checkConfig.schema,
                    group: checkConfig.group,
                    ai: {
                        timeout: timeout || 600000,
                        debug: debug, // Pass debug flag to AI provider
                        ...(checkConfig.ai || {}),
                    },
                };
                const result = await provider.execute(prInfo, providerConfig);
                console.error(`🔧 Debug: Completed check: ${checkName}, issues found: ${result.issues.length}`);
                // Add group, schema info and timestamp to issues from config
                const enrichedIssues = result.issues.map(issue => ({
                    ...issue,
                    ruleId: `${checkName}/${issue.ruleId}`,
                    group: checkConfig.group,
                    schema: checkConfig.schema,
                    template: checkConfig.template,
                    timestamp: Date.now(),
                }));
                const enrichedResult = {
                    ...result,
                    issues: enrichedIssues,
                };
                return {
                    checkName,
                    error: null,
                    result: enrichedResult,
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log(`🔧 Debug: Error in check ${checkName}: ${errorMessage}`);
                return {
                    checkName,
                    error: errorMessage,
                    result: null,
                };
            }
        });
        // Execute all checks in parallel using Promise.allSettled
        log(`🔧 Debug: Executing ${checkTasks.length} checks in parallel`);
        const results = await Promise.allSettled(checkTasks);
        // Aggregate results from all checks
        return this.aggregateParallelResults(results, checks, debug);
    }
    /**
     * Execute a single configured check
     */
    async executeSingleConfiguredCheck(prInfo, checkName, timeout, config, _logFn) {
        if (!config?.checks?.[checkName]) {
            throw new Error(`No configuration found for check: ${checkName}`);
        }
        const checkConfig = config.checks[checkName];
        const provider = this.providerRegistry.getProviderOrThrow('ai');
        const providerConfig = {
            type: 'ai',
            prompt: checkConfig.prompt,
            focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
            schema: checkConfig.schema,
            group: checkConfig.group,
            ai: {
                timeout: timeout || 600000,
                ...(checkConfig.ai || {}),
            },
            // Inherit global AI provider and model settings
            ai_provider: checkConfig.ai_provider || config.ai_provider,
            ai_model: checkConfig.ai_model || config.ai_model,
        };
        const result = await provider.execute(prInfo, providerConfig);
        // Prefix issues with check name and add group/schema info and timestamp from config
        const prefixedIssues = result.issues.map(issue => ({
            ...issue,
            ruleId: `${checkName}/${issue.ruleId}`,
            group: checkConfig.group,
            schema: checkConfig.schema,
            timestamp: Date.now(),
        }));
        return {
            ...result,
            issues: prefixedIssues,
        };
    }
    /**
     * Map check name to focus for AI provider
     * This is a fallback when focus is not explicitly configured
     */
    mapCheckNameToFocus(checkName) {
        const focusMap = {
            security: 'security',
            performance: 'performance',
            style: 'style',
            architecture: 'architecture',
        };
        return focusMap[checkName] || 'all';
    }
    /**
     * Aggregate results from dependency-aware check execution
     */
    aggregateDependencyAwareResults(results, dependencyGraph, debug) {
        const aggregatedIssues = [];
        const aggregatedSuggestions = [];
        const debugInfo = [];
        // Add execution plan info
        const stats = dependency_resolver_1.DependencyResolver.getExecutionStats(dependencyGraph);
        debugInfo.push(`🔍 Dependency-aware execution completed:`, `  - ${stats.totalChecks} checks in ${stats.parallelLevels} execution levels`, `  - Maximum parallelism: ${stats.maxParallelism}`, `  - Average parallelism: ${stats.averageParallelism.toFixed(1)}`, `  - Checks with dependencies: ${stats.checksWithDependencies}`);
        // Process results in dependency order for better output organization
        for (const executionGroup of dependencyGraph.executionOrder) {
            for (const checkName of executionGroup.parallel) {
                const result = results.get(checkName);
                if (!result) {
                    debugInfo.push(`❌ Check "${checkName}" had no result`);
                    continue;
                }
                // Check if this was a successful result
                const hasErrors = result.issues.some(issue => issue.ruleId?.includes('/error') || issue.ruleId?.includes('/promise-error'));
                if (hasErrors) {
                    debugInfo.push(`❌ Check "${checkName}" failed with errors`);
                }
                else {
                    debugInfo.push(`✅ Check "${checkName}" completed: ${result.issues.length} issues found (level ${executionGroup.level})`);
                }
                // Issues are already prefixed and enriched with group/schema info
                aggregatedIssues.push(...result.issues);
                // Add suggestions with check name prefix
                const prefixedSuggestions = result.suggestions.map(suggestion => `[${checkName}] ${suggestion}`);
                aggregatedSuggestions.push(...prefixedSuggestions);
            }
        }
        // Add summary information
        aggregatedSuggestions.unshift(...debugInfo);
        console.error(`🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.size} dependency-aware checks`);
        // Collect debug information when debug mode is enabled
        let aggregatedDebug;
        if (debug) {
            const debugResults = Array.from(results.entries()).filter(([_, result]) => result.debug);
            if (debugResults.length > 0) {
                const [, firstResult] = debugResults[0];
                const firstDebug = firstResult.debug;
                const totalProcessingTime = debugResults.reduce((sum, [_, result]) => {
                    return sum + (result.debug.processingTime || 0);
                }, 0);
                aggregatedDebug = {
                    provider: firstDebug.provider,
                    model: firstDebug.model,
                    apiKeySource: firstDebug.apiKeySource,
                    processingTime: totalProcessingTime,
                    prompt: debugResults
                        .map(([checkName, result]) => `[${checkName}]\n${result.debug.prompt}`)
                        .join('\n\n'),
                    rawResponse: debugResults
                        .map(([checkName, result]) => `[${checkName}]\n${result.debug.rawResponse}`)
                        .join('\n\n'),
                    promptLength: debugResults.reduce((sum, [_, result]) => sum + (result.debug.promptLength || 0), 0),
                    responseLength: debugResults.reduce((sum, [_, result]) => sum + (result.debug.responseLength || 0), 0),
                    jsonParseSuccess: debugResults.every(([_, result]) => result.debug.jsonParseSuccess),
                    errors: debugResults.flatMap(([checkName, result]) => (result.debug.errors || []).map((error) => `[${checkName}] ${error}`)),
                    timestamp: new Date().toISOString(),
                    totalApiCalls: debugResults.length,
                    apiCallDetails: debugResults.map(([checkName, result]) => ({
                        checkName,
                        provider: result.debug.provider,
                        model: result.debug.model,
                        processingTime: result.debug.processingTime,
                        success: result.debug.jsonParseSuccess,
                    })),
                };
            }
        }
        return {
            issues: aggregatedIssues,
            suggestions: aggregatedSuggestions,
            debug: aggregatedDebug,
        };
    }
    /**
     * Aggregate results from parallel check execution (legacy method)
     */
    aggregateParallelResults(results, checkNames, debug) {
        const aggregatedIssues = [];
        const aggregatedSuggestions = [];
        const debugInfo = [];
        let successfulChecks = 0;
        let failedChecks = 0;
        results.forEach((result, index) => {
            const checkName = checkNames[index];
            if (result.status === 'fulfilled') {
                const checkResult = result.value;
                if (checkResult.error) {
                    failedChecks++;
                    const log = console.error;
                    log(`🔧 Debug: Check ${checkName} failed: ${checkResult.error}`);
                    debugInfo.push(`❌ Check "${checkName}" failed: ${checkResult.error}`);
                    // Check if this is a critical error
                    const isCriticalError = checkResult.error.includes('API rate limit') ||
                        checkResult.error.includes('403') ||
                        checkResult.error.includes('401') ||
                        checkResult.error.includes('authentication') ||
                        checkResult.error.includes('API key');
                    // Add error as an issue with appropriate severity
                    aggregatedIssues.push({
                        file: 'system',
                        line: 0,
                        endLine: undefined,
                        ruleId: `${checkName}/error`,
                        message: `Check "${checkName}" failed: ${checkResult.error}`,
                        severity: isCriticalError ? 'critical' : 'error',
                        category: 'logic',
                        suggestion: isCriticalError
                            ? 'Please check your API credentials and rate limits'
                            : undefined,
                        replacement: undefined,
                    });
                }
                else if (checkResult.result) {
                    successfulChecks++;
                    console.error(`🔧 Debug: Check ${checkName} succeeded with ${checkResult.result.issues.length} issues`);
                    debugInfo.push(`✅ Check "${checkName}" completed: ${checkResult.result.issues.length} issues found`);
                    // Issues are already prefixed and enriched with group/schema info
                    aggregatedIssues.push(...checkResult.result.issues);
                    // Add suggestions with check name prefix
                    const prefixedSuggestions = checkResult.result.suggestions.map(suggestion => `[${checkName}] ${suggestion}`);
                    aggregatedSuggestions.push(...prefixedSuggestions);
                }
            }
            else {
                failedChecks++;
                const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
                const log = console.error;
                log(`🔧 Debug: Check ${checkName} promise rejected: ${errorMessage}`);
                debugInfo.push(`❌ Check "${checkName}" promise rejected: ${errorMessage}`);
                // Check if this is a critical error
                const isCriticalError = errorMessage.includes('API rate limit') ||
                    errorMessage.includes('403') ||
                    errorMessage.includes('401') ||
                    errorMessage.includes('authentication') ||
                    errorMessage.includes('API key');
                aggregatedIssues.push({
                    file: 'system',
                    line: 0,
                    endLine: undefined,
                    ruleId: `${checkName}/promise-error`,
                    message: `Check "${checkName}" execution failed: ${errorMessage}`,
                    severity: isCriticalError ? 'critical' : 'error',
                    category: 'logic',
                    suggestion: isCriticalError
                        ? 'Please check your API credentials and rate limits'
                        : undefined,
                    replacement: undefined,
                });
            }
        });
        // Add summary information
        debugInfo.unshift(`🔍 Parallel execution completed: ${successfulChecks} successful, ${failedChecks} failed`);
        aggregatedSuggestions.unshift(...debugInfo);
        console.error(`🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`);
        // Collect debug information when debug mode is enabled
        let aggregatedDebug;
        if (debug) {
            // Find the first successful result with debug information to use as template
            const debugResults = results
                .map((result, index) => ({
                result,
                checkName: checkNames[index],
            }))
                .filter(({ result }) => result.status === 'fulfilled' && result.value?.result?.debug);
            if (debugResults.length > 0) {
                const firstResult = debugResults[0].result;
                if (firstResult.status === 'fulfilled') {
                    const firstDebug = firstResult.value.result.debug;
                    const totalProcessingTime = debugResults.reduce((sum, { result }) => {
                        if (result.status === 'fulfilled') {
                            return sum + (result.value.result.debug.processingTime || 0);
                        }
                        return sum;
                    }, 0);
                    aggregatedDebug = {
                        // Use first result as template for provider/model info
                        provider: firstDebug.provider,
                        model: firstDebug.model,
                        apiKeySource: firstDebug.apiKeySource,
                        // Aggregate processing time from all checks
                        processingTime: totalProcessingTime,
                        // Combine prompts with check names
                        prompt: debugResults
                            .map(({ checkName, result }) => {
                            if (result.status === 'fulfilled') {
                                return `[${checkName}]\n${result.value.result.debug.prompt}`;
                            }
                            return `[${checkName}] Error: Promise was rejected`;
                        })
                            .join('\n\n'),
                        // Combine responses
                        rawResponse: debugResults
                            .map(({ checkName, result }) => {
                            if (result.status === 'fulfilled') {
                                return `[${checkName}]\n${result.value.result.debug.rawResponse}`;
                            }
                            return `[${checkName}] Error: Promise was rejected`;
                        })
                            .join('\n\n'),
                        promptLength: debugResults.reduce((sum, { result }) => {
                            if (result.status === 'fulfilled') {
                                return sum + (result.value.result.debug.promptLength || 0);
                            }
                            return sum;
                        }, 0),
                        responseLength: debugResults.reduce((sum, { result }) => {
                            if (result.status === 'fulfilled') {
                                return sum + (result.value.result.debug.responseLength || 0);
                            }
                            return sum;
                        }, 0),
                        jsonParseSuccess: debugResults.every(({ result }) => {
                            if (result.status === 'fulfilled') {
                                return result.value.result.debug.jsonParseSuccess;
                            }
                            return false;
                        }),
                        errors: debugResults.flatMap(({ result, checkName }) => {
                            if (result.status === 'fulfilled') {
                                return (result.value.result.debug.errors || []).map((error) => `[${checkName}] ${error}`);
                            }
                            return [`[${checkName}] Promise was rejected`];
                        }),
                        timestamp: new Date().toISOString(),
                        // Add additional debug information for parallel execution
                        totalApiCalls: debugResults.length,
                        apiCallDetails: debugResults.map(({ checkName, result }) => {
                            if (result.status === 'fulfilled') {
                                return {
                                    checkName,
                                    provider: result.value.result.debug.provider,
                                    model: result.value.result.debug.model,
                                    processingTime: result.value.result.debug.processingTime,
                                    success: result.value.result.debug.jsonParseSuccess,
                                };
                            }
                            return {
                                checkName,
                                provider: 'unknown',
                                model: 'unknown',
                                processingTime: 0,
                                success: false,
                            };
                        }),
                    };
                }
            }
        }
        return {
            issues: aggregatedIssues,
            suggestions: aggregatedSuggestions,
            debug: aggregatedDebug,
        };
    }
    /**
     * Get available check types
     */
    static getAvailableCheckTypes() {
        const registry = check_provider_registry_1.CheckProviderRegistry.getInstance();
        const providerTypes = registry.getAvailableProviders();
        // Add standard focus-based checks
        const standardTypes = ['security', 'performance', 'style', 'architecture', 'all'];
        // Combine provider types with standard types (remove duplicates)
        return [...new Set([...providerTypes, ...standardTypes])];
    }
    /**
     * Validate check types
     */
    static validateCheckTypes(checks) {
        const availableChecks = CheckExecutionEngine.getAvailableCheckTypes();
        const valid = [];
        const invalid = [];
        for (const check of checks) {
            if (availableChecks.includes(check)) {
                valid.push(check);
            }
            else {
                invalid.push(check);
            }
        }
        return { valid, invalid };
    }
    /**
     * List available providers with their status
     */
    async listProviders() {
        return await this.providerRegistry.listProviders();
    }
    /**
     * Create a mock Octokit instance for local analysis
     */
    createMockOctokit() {
        // Create simple mock functions that return promises
        const mockGet = async () => ({
            data: {
                number: 0,
                title: 'Local Analysis',
                body: 'Local repository analysis',
                user: { login: 'local-user' },
                base: { ref: 'main' },
                head: { ref: 'HEAD' },
            },
        });
        const mockListFiles = async () => ({
            data: [],
        });
        const mockListComments = async () => ({
            data: [],
        });
        const mockCreateComment = async () => ({
            data: { id: 1 },
        });
        return {
            rest: {
                pulls: {
                    get: mockGet,
                    listFiles: mockListFiles,
                },
                issues: {
                    listComments: mockListComments,
                    createComment: mockCreateComment,
                },
            },
            request: async () => ({ data: {} }),
            graphql: async () => ({}),
            log: {
                debug: () => { },
                info: () => { },
                warn: () => { },
                error: () => { },
            },
            hook: {
                before: () => { },
                after: () => { },
                error: () => { },
                wrap: () => { },
            },
            auth: async () => ({ token: 'mock-token' }),
        };
    }
    /**
     * Create an error result
     */
    createErrorResult(repositoryInfo, errorMessage, startTime, timestamp, checksExecuted) {
        const executionTime = Date.now() - startTime;
        return {
            repositoryInfo,
            reviewSummary: {
                issues: [
                    {
                        file: 'system',
                        line: 0,
                        endLine: undefined,
                        ruleId: 'system/error',
                        message: errorMessage,
                        severity: 'error',
                        category: 'logic',
                        suggestion: undefined,
                        replacement: undefined,
                    },
                ],
                suggestions: [`Error: ${errorMessage}`],
            },
            executionTime,
            timestamp,
            checksExecuted,
        };
    }
    /**
     * Check if the working directory is a valid git repository
     */
    async isGitRepository() {
        try {
            const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
            return repositoryInfo.isGitRepository;
        }
        catch {
            return false;
        }
    }
    /**
     * Evaluate failure conditions for a check result
     */
    async evaluateFailureConditions(checkName, reviewSummary, config) {
        if (!config) {
            return [];
        }
        const checkConfig = config.checks[checkName];
        const checkSchema = checkConfig?.schema || '';
        const checkGroup = checkConfig?.group || '';
        // Handle new simple fail_if syntax
        const globalFailIf = config.fail_if;
        const checkFailIf = checkConfig?.fail_if;
        // If using new fail_if syntax
        if (globalFailIf || checkFailIf) {
            const results = [];
            // Evaluate global fail_if
            if (globalFailIf) {
                const failed = await this.failureEvaluator.evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, globalFailIf);
                if (failed) {
                    results.push({
                        conditionName: 'global_fail_if',
                        expression: globalFailIf,
                        failed: true,
                        severity: 'error',
                        message: 'Global failure condition met',
                        haltExecution: false,
                    });
                }
            }
            // Evaluate check-specific fail_if (overrides global if present)
            if (checkFailIf) {
                const failed = await this.failureEvaluator.evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, checkFailIf);
                if (failed) {
                    results.push({
                        conditionName: `${checkName}_fail_if`,
                        expression: checkFailIf,
                        failed: true,
                        severity: 'error',
                        message: `Check ${checkName} failure condition met`,
                        haltExecution: false,
                    });
                }
            }
            return results;
        }
        // Fall back to old failure_conditions syntax
        const globalConditions = config.failure_conditions;
        const checkConditions = checkConfig?.failure_conditions;
        return await this.failureEvaluator.evaluateConditions(checkName, checkSchema, checkGroup, reviewSummary, globalConditions, checkConditions);
    }
    /**
     * Get repository status summary
     */
    async getRepositoryStatus() {
        try {
            const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
            return {
                isGitRepository: repositoryInfo.isGitRepository,
                hasChanges: repositoryInfo.files.length > 0,
                branch: repositoryInfo.head,
                filesChanged: repositoryInfo.files.length,
            };
        }
        catch {
            return {
                isGitRepository: false,
                hasChanges: false,
                branch: 'unknown',
                filesChanged: 0,
            };
        }
    }
    /**
     * Initialize GitHub check runs for each configured check
     */
    async initializeGitHubChecks(options, logFn) {
        if (!options.githubChecks?.octokit ||
            !options.githubChecks.owner ||
            !options.githubChecks.repo ||
            !options.githubChecks.headSha) {
            logFn('⚠️ GitHub checks enabled but missing required parameters');
            return;
        }
        try {
            this.githubCheckService = new github_check_service_1.GitHubCheckService(options.githubChecks.octokit);
            this.checkRunMap = new Map();
            this.githubContext = {
                owner: options.githubChecks.owner,
                repo: options.githubChecks.repo,
            };
            logFn(`🔍 Creating GitHub check runs for ${options.checks.length} checks...`);
            for (const checkName of options.checks) {
                try {
                    const checkRunOptions = {
                        owner: options.githubChecks.owner,
                        repo: options.githubChecks.repo,
                        head_sha: options.githubChecks.headSha,
                        name: `Visor: ${checkName}`,
                        external_id: `visor-${checkName}-${options.githubChecks.headSha.substring(0, 7)}`,
                    };
                    const checkRun = await this.githubCheckService.createCheckRun(checkRunOptions, {
                        title: `${checkName} Analysis`,
                        summary: `Running ${checkName} check using AI-powered analysis...`,
                    });
                    this.checkRunMap.set(checkName, checkRun);
                    logFn(`✅ Created check run for ${checkName}: ${checkRun.url}`);
                }
                catch (error) {
                    logFn(`❌ Failed to create check run for ${checkName}: ${error}`);
                }
            }
        }
        catch (error) {
            // Check if this is a permissions error
            if (error instanceof Error &&
                (error.message.includes('403') || error.message.includes('checks:write'))) {
                logFn('⚠️ GitHub checks API not available - insufficient permissions. Check runs will be skipped.');
                logFn('💡 To enable check runs, ensure your GitHub token has "checks:write" permission.');
                this.githubCheckService = undefined;
                this.checkRunMap = undefined;
            }
            else {
                logFn(`❌ Failed to initialize GitHub check runs: ${error}`);
                this.githubCheckService = undefined;
                this.checkRunMap = undefined;
            }
        }
    }
    /**
     * Update GitHub check runs to in-progress status
     */
    async updateGitHubChecksInProgress(options) {
        if (!this.githubCheckService ||
            !this.checkRunMap ||
            !options.githubChecks?.owner ||
            !options.githubChecks.repo) {
            return;
        }
        for (const [checkName, checkRun] of this.checkRunMap) {
            try {
                await this.githubCheckService.updateCheckRunInProgress(options.githubChecks.owner, options.githubChecks.repo, checkRun.id, {
                    title: `Analyzing with ${checkName}...`,
                    summary: `AI-powered analysis is in progress for ${checkName} check.`,
                });
                console.log(`🔄 Updated ${checkName} check to in-progress status`);
            }
            catch (error) {
                console.error(`❌ Failed to update ${checkName} check to in-progress: ${error}`);
            }
        }
    }
    /**
     * Complete GitHub check runs with results
     */
    async completeGitHubChecksWithResults(reviewSummary, options) {
        if (!this.githubCheckService ||
            !this.checkRunMap ||
            !options.githubChecks?.owner ||
            !options.githubChecks.repo) {
            return;
        }
        // Group issues by check name
        const issuesByCheck = new Map();
        // Initialize empty arrays for all checks
        for (const checkName of this.checkRunMap.keys()) {
            issuesByCheck.set(checkName, []);
        }
        // Group issues by their check name (extracted from ruleId prefix)
        for (const issue of reviewSummary.issues || []) {
            if (issue.ruleId && issue.ruleId.includes('/')) {
                const checkName = issue.ruleId.split('/')[0];
                if (issuesByCheck.has(checkName)) {
                    issuesByCheck.get(checkName).push(issue);
                }
            }
        }
        console.log(`🏁 Completing ${this.checkRunMap.size} GitHub check runs...`);
        for (const [checkName, checkRun] of this.checkRunMap) {
            try {
                const checkIssues = issuesByCheck.get(checkName) || [];
                // Evaluate failure conditions for this specific check
                const failureResults = await this.evaluateFailureConditions(checkName, { issues: checkIssues, suggestions: [] }, options.config);
                await this.githubCheckService.completeCheckRun(options.githubChecks.owner, options.githubChecks.repo, checkRun.id, checkName, failureResults, checkIssues);
                console.log(`✅ Completed ${checkName} check with ${checkIssues.length} issues`);
            }
            catch (error) {
                console.error(`❌ Failed to complete ${checkName} check: ${error}`);
                // Try to mark the check as failed due to execution error
                try {
                    await this.githubCheckService.completeCheckRun(options.githubChecks.owner, options.githubChecks.repo, checkRun.id, checkName, [], [], error instanceof Error ? error.message : 'Unknown error occurred');
                }
                catch (finalError) {
                    console.error(`❌ Failed to mark ${checkName} check as failed: ${finalError}`);
                }
            }
        }
    }
    /**
     * Complete GitHub check runs with error status
     */
    async completeGitHubChecksWithError(errorMessage) {
        if (!this.githubCheckService || !this.checkRunMap || !this.githubContext) {
            return;
        }
        console.log(`❌ Completing ${this.checkRunMap.size} GitHub check runs with error...`);
        for (const [checkName, checkRun] of this.checkRunMap) {
            try {
                await this.githubCheckService.completeCheckRun(this.githubContext.owner, this.githubContext.repo, checkRun.id, checkName, [], [], errorMessage);
                console.log(`❌ Completed ${checkName} check with error: ${errorMessage}`);
            }
            catch (error) {
                console.error(`❌ Failed to complete ${checkName} check with error: ${error}`);
            }
        }
    }
}
exports.CheckExecutionEngine = CheckExecutionEngine;
//# sourceMappingURL=check-execution-engine.js.map