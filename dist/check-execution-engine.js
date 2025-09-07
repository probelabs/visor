"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckExecutionEngine = void 0;
const reviewer_1 = require("./reviewer");
const git_repository_analyzer_1 = require("./git-repository-analyzer");
const check_provider_registry_1 = require("./providers/check-provider-registry");
class CheckExecutionEngine {
    gitAnalyzer;
    mockOctokit;
    reviewer;
    providerRegistry;
    constructor(workingDirectory) {
        this.gitAnalyzer = new git_repository_analyzer_1.GitRepositoryAnalyzer(workingDirectory);
        this.providerRegistry = check_provider_registry_1.CheckProviderRegistry.getInstance();
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
            // Analyze the repository
            logFn('🔍 Analyzing local git repository...');
            const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
            if (!repositoryInfo.isGitRepository) {
                return this.createErrorResult(repositoryInfo, 'Not a git repository or no changes found', startTime, timestamp, options.checks);
            }
            // Convert to PRInfo format for compatibility with existing reviewer
            const prInfo = this.gitAnalyzer.toPRInfo(repositoryInfo);
            // Execute checks using the existing PRReviewer
            logFn(`🤖 Executing checks: ${options.checks.join(', ')}`);
            const reviewSummary = await this.executeReviewChecks(prInfo, options.checks, options.timeout, options.config, options.outputFormat);
            const executionTime = Date.now() - startTime;
            return {
                repositoryInfo,
                reviewSummary,
                executionTime,
                timestamp,
                checksExecuted: options.checks,
            };
        }
        catch (error) {
            console.error('Error executing checks:', error);
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
    async executeReviewChecks(prInfo, checks, timeout, config, outputFormat) {
        // Determine where to send log messages based on output format
        const logFn = outputFormat === 'json' || outputFormat === 'sarif'
            ? console.error
            : console.log;
        logFn(`🔧 Debug: executeReviewChecks called with checks: ${JSON.stringify(checks)}`);
        logFn(`🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);
        // If we have a config with individual check definitions, use parallel execution
        if (config?.checks && checks.length > 1) {
            logFn(`🔧 Debug: Using parallel execution for ${checks.length} checks`);
            return await this.executeParallelChecks(prInfo, checks, timeout, config, logFn);
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
                return await provider.execute(prInfo, providerConfig);
            }
        }
        // Check if 'ai' provider is available for focus-based checks (legacy support)
        if (this.providerRegistry.hasProvider('ai')) {
            logFn(`🔧 Debug: Using AI provider with focus mapping`);
            const provider = this.providerRegistry.getProviderOrThrow('ai');
            let focus = 'all';
            if (checks.length === 1) {
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
            };
            return await provider.execute(prInfo, providerConfig);
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
     * Execute multiple checks in parallel using Promise.allSettled
     */
    async executeParallelChecks(prInfo, checks, timeout, config, logFn) {
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
                // Create provider config for this specific check
                const providerConfig = {
                    type: 'ai',
                    prompt: checkConfig.prompt,
                    focus: this.mapCheckNameToFocus(checkName),
                    ai: {
                        timeout: timeout || 600000,
                        ...(checkConfig.ai || {}),
                    },
                };
                const result = await provider.execute(prInfo, providerConfig);
                console.error(`🔧 Debug: Completed check: ${checkName}, issues found: ${result.issues.length}`);
                return {
                    checkName,
                    error: null,
                    result,
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
        return this.aggregateParallelResults(results, checks);
    }
    /**
     * Execute a single configured check
     */
    async executeSingleConfiguredCheck(prInfo, checkName, timeout, config, logFn) {
        if (!config?.checks?.[checkName]) {
            throw new Error(`No configuration found for check: ${checkName}`);
        }
        const checkConfig = config.checks[checkName];
        const provider = this.providerRegistry.getProviderOrThrow('ai');
        const providerConfig = {
            type: 'ai',
            prompt: checkConfig.prompt,
            focus: this.mapCheckNameToFocus(checkName),
            ai: {
                timeout: timeout || 600000,
                ...(checkConfig.ai || {}),
            },
        };
        return await provider.execute(prInfo, providerConfig);
    }
    /**
     * Map check name to focus for AI provider
     */
    mapCheckNameToFocus(checkName) {
        const focusMap = {
            security: 'security',
            performance: 'performance',
            style: 'style',
            architecture: 'all', // architecture maps to 'all' focus
        };
        return focusMap[checkName] || 'all';
    }
    /**
     * Aggregate results from parallel check execution
     */
    aggregateParallelResults(results, checkNames) {
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
                    // Add error as an issue
                    aggregatedIssues.push({
                        file: 'system',
                        line: 0,
                        endLine: undefined,
                        ruleId: `${checkName}/error`,
                        message: `Check "${checkName}" failed: ${checkResult.error}`,
                        severity: 'error',
                        category: 'logic',
                        suggestion: undefined,
                        replacement: undefined,
                    });
                }
                else if (checkResult.result) {
                    successfulChecks++;
                    console.error(`🔧 Debug: Check ${checkName} succeeded with ${checkResult.result.issues.length} issues`);
                    debugInfo.push(`✅ Check "${checkName}" completed: ${checkResult.result.issues.length} issues found`);
                    // Prefix issues with check name for identification
                    const prefixedIssues = checkResult.result.issues.map(issue => ({
                        ...issue,
                        ruleId: `${checkName}/${issue.ruleId}`,
                    }));
                    aggregatedIssues.push(...prefixedIssues);
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
                aggregatedIssues.push({
                    file: 'system',
                    line: 0,
                    endLine: undefined,
                    ruleId: `${checkName}/promise-error`,
                    message: `Check "${checkName}" execution failed: ${errorMessage}`,
                    severity: 'error',
                    category: 'logic',
                    suggestion: undefined,
                    replacement: undefined,
                });
            }
        });
        // Add summary information
        debugInfo.unshift(`🔍 Parallel execution completed: ${successfulChecks} successful, ${failedChecks} failed`);
        aggregatedSuggestions.unshift(...debugInfo);
        console.error(`🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`);
        return {
            issues: aggregatedIssues,
            suggestions: aggregatedSuggestions,
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
}
exports.CheckExecutionEngine = CheckExecutionEngine;
//# sourceMappingURL=check-execution-engine.js.map