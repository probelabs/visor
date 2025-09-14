"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AICheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
const ai_review_service_1 = require("../ai-review-service");
const env_resolver_1 = require("../utils/env-resolver");
const liquidjs_1 = require("liquidjs");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
/**
 * AI-powered check provider using probe agent
 */
class AICheckProvider extends check_provider_interface_1.CheckProvider {
    aiReviewService;
    liquidEngine;
    constructor() {
        super();
        this.aiReviewService = new ai_review_service_1.AIReviewService();
        this.liquidEngine = new liquidjs_1.Liquid();
    }
    getName() {
        return 'ai';
    }
    getDescription() {
        return 'AI-powered code review using Google Gemini, Anthropic Claude, or OpenAI GPT models';
    }
    async validateConfig(config) {
        if (!config || typeof config !== 'object') {
            return false;
        }
        const cfg = config;
        // Type must be 'ai'
        if (cfg.type !== 'ai') {
            return false;
        }
        // Check for prompt or focus
        const prompt = cfg.prompt || cfg.focus;
        if (typeof prompt !== 'string') {
            return false;
        }
        // Validate focus if specified
        if (cfg.focus && !['security', 'performance', 'style', 'all'].includes(cfg.focus)) {
            return false;
        }
        // Validate AI provider config if present
        if (cfg.ai) {
            if (cfg.ai.provider &&
                !['google', 'anthropic', 'openai', 'mock'].includes(cfg.ai.provider)) {
                return false;
            }
        }
        return true;
    }
    /**
     * Group files by their file extension for template context
     */
    groupFilesByExtension(files) {
        const grouped = {};
        files.forEach(file => {
            const parts = file.filename.split('.');
            const ext = parts.length > 1 ? parts.pop()?.toLowerCase() : 'noext';
            if (!grouped[ext]) {
                grouped[ext] = [];
            }
            grouped[ext].push(file);
        });
        return grouped;
    }
    /**
     * Process prompt configuration to resolve final prompt string
     */
    async processPrompt(promptConfig, prInfo, eventContext, dependencyResults) {
        let promptContent;
        // Auto-detect if it's a file path or inline content
        if (await this.isFilePath(promptConfig)) {
            promptContent = await this.loadPromptFromFile(promptConfig);
        }
        else {
            promptContent = promptConfig;
        }
        // Process Liquid templates in the prompt
        return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
    }
    /**
     * Detect if a string is likely a file path and if the file exists
     */
    async isFilePath(str) {
        // Quick checks to exclude obvious non-file-path content
        if (!str || str.trim() !== str || str.length > 512) {
            return false;
        }
        // Exclude strings that are clearly content (contain common content indicators)
        // But be more careful with paths that might contain common words as directory names
        if (/\s{2,}/.test(str) || // Multiple consecutive spaces
            /\n/.test(str) || // Contains newlines
            /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
            str.split(' ').length > 8 // Too many words for a typical file path
        ) {
            return false;
        }
        // For strings with path separators, be more lenient about common words
        // as they might be legitimate directory names
        if (!/[\/\\]/.test(str)) {
            // Only apply strict English word filter to non-path strings
            if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
                return false;
            }
        }
        // Positive indicators for file paths
        const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
        const hasPathSeparators = /[\/\\]/.test(str);
        const isRelativePath = /^\.{1,2}\//.test(str);
        const isAbsolutePath = path_1.default.isAbsolute(str);
        const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
        // Must have at least one strong indicator
        if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
            return false;
        }
        // Must contain only typical file path characters
        if (!hasTypicalFileChars) {
            return false;
        }
        // Additional validation for suspected file paths
        try {
            // Try to resolve and check if file exists
            let resolvedPath;
            if (path_1.default.isAbsolute(str)) {
                resolvedPath = path_1.default.normalize(str);
            }
            else {
                // Resolve relative to current working directory
                resolvedPath = path_1.default.resolve(process.cwd(), str);
            }
            // Check if file exists
            const fs = require('fs').promises;
            try {
                const stat = await fs.stat(resolvedPath);
                return stat.isFile();
            }
            catch {
                // File doesn't exist, but might still be a valid file path format
                // Return true if it has strong file path indicators
                return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
            }
        }
        catch {
            return false;
        }
    }
    /**
     * Load prompt content from file with security validation
     */
    async loadPromptFromFile(promptPath) {
        let resolvedPath;
        if (path_1.default.isAbsolute(promptPath)) {
            // Absolute path - use as-is
            resolvedPath = promptPath;
        }
        else {
            // Relative path - resolve relative to current working directory
            resolvedPath = path_1.default.resolve(process.cwd(), promptPath);
        }
        // Security: For relative paths, ensure they don't escape the current directory
        if (!path_1.default.isAbsolute(promptPath)) {
            const normalizedPath = path_1.default.normalize(resolvedPath);
            const currentDir = path_1.default.resolve(process.cwd());
            if (!normalizedPath.startsWith(currentDir)) {
                throw new Error('Invalid prompt file path: path traversal detected');
            }
        }
        // Security: Check for obvious path traversal patterns
        if (promptPath.includes('../..')) {
            throw new Error('Invalid prompt file path: path traversal detected');
        }
        try {
            const promptContent = await promises_1.default.readFile(resolvedPath, 'utf-8');
            return promptContent;
        }
        catch (error) {
            throw new Error(`Failed to load prompt from ${resolvedPath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Render Liquid template in prompt with comprehensive event context
     */
    async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults) {
        // Create comprehensive template context with PR and event information
        const templateContext = {
            // PR Information
            pr: {
                number: prInfo.number,
                title: prInfo.title,
                body: prInfo.body,
                author: prInfo.author,
                baseBranch: prInfo.base,
                headBranch: prInfo.head,
                isIncremental: prInfo.isIncremental,
                filesChanged: prInfo.files?.map(f => f.filename) || [],
                totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
                totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
                totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
                base: prInfo.base,
                head: prInfo.head,
            },
            // File Details
            files: prInfo.files || [],
            description: prInfo.body || '',
            // GitHub Event Context
            event: eventContext
                ? {
                    name: eventContext.event_name || 'unknown',
                    action: eventContext.action,
                    // Repository Info
                    repository: eventContext.repository
                        ? {
                            owner: eventContext.repository.owner?.login,
                            name: eventContext.repository.name,
                            fullName: eventContext.repository
                                ? `${eventContext.repository.owner?.login}/${eventContext.repository.name}`
                                : undefined,
                        }
                        : undefined,
                    // Comment Data (for comment events)
                    comment: eventContext.comment
                        ? {
                            body: eventContext.comment.body,
                            author: eventContext.comment.user?.login,
                        }
                        : undefined,
                    // Issue Data (for issue events)
                    issue: eventContext.issue
                        ? {
                            number: eventContext.issue.number,
                            isPullRequest: !!eventContext.issue.pull_request,
                        }
                        : undefined,
                    // Pull Request Event Data
                    pullRequest: eventContext.pull_request
                        ? {
                            number: eventContext.pull_request.number,
                            state: eventContext.pull_request.state,
                            draft: eventContext.pull_request.draft,
                            headSha: eventContext.pull_request.head?.sha,
                            headRef: eventContext.pull_request.head?.ref,
                            baseSha: eventContext.pull_request.base?.sha,
                            baseRef: eventContext.pull_request.base?.ref,
                        }
                        : undefined,
                    // Raw event payload for advanced use cases
                    payload: eventContext,
                }
                : undefined,
            // Utility data for templates
            utils: {
                // Date/time helpers
                now: new Date().toISOString(),
                today: new Date().toISOString().split('T')[0],
                // Dynamic file grouping by extension
                filesByExtension: this.groupFilesByExtension(prInfo.files || []),
                // File status categorizations
                addedFiles: (prInfo.files || []).filter(f => f.status === 'added'),
                modifiedFiles: (prInfo.files || []).filter(f => f.status === 'modified'),
                removedFiles: (prInfo.files || []).filter(f => f.status === 'removed'),
                renamedFiles: (prInfo.files || []).filter(f => f.status === 'renamed'),
                // Change analysis
                hasLargeChanges: (prInfo.files || []).some(f => f.changes > 50),
                totalFiles: (prInfo.files || []).length,
            },
            // Previous check outputs (dependency results)
            outputs: dependencyResults
                ? Object.fromEntries(Array.from(dependencyResults.entries()).map(([checkName, result]) => [
                    checkName,
                    {
                        // Summary data
                        totalIssues: result.issues?.length || 0,
                        criticalIssues: result.issues?.filter(i => i.severity === 'critical').length || 0,
                        errorIssues: result.issues?.filter(i => i.severity === 'error').length || 0,
                        warningIssues: result.issues?.filter(i => i.severity === 'warning').length || 0,
                        infoIssues: result.issues?.filter(i => i.severity === 'info').length || 0,
                        // Issues grouped by category
                        securityIssues: result.issues?.filter(i => i.category === 'security') || [],
                        performanceIssues: result.issues?.filter(i => i.category === 'performance') || [],
                        styleIssues: result.issues?.filter(i => i.category === 'style') || [],
                        logicIssues: result.issues?.filter(i => i.category === 'logic') || [],
                        documentationIssues: result.issues?.filter(i => i.category === 'documentation') || [],
                        // All issues and suggestions
                        issues: result.issues || [],
                        suggestions: result.suggestions || [],
                        // Debug information if available
                        debug: result.debug,
                        // Raw data for advanced use
                        raw: result,
                    },
                ]))
                : {},
        };
        try {
            return await this.liquidEngine.parseAndRender(promptContent, templateContext);
        }
        catch (error) {
            throw new Error(`Failed to render prompt template: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    async execute(prInfo, config, _dependencyResults) {
        // Apply environment configuration if present
        if (config.env) {
            const result = env_resolver_1.EnvironmentResolver.withTemporaryEnv(config.env, () => {
                // This will be executed with the temporary environment
                return this.executeWithConfig(prInfo, config, _dependencyResults);
            });
            if (result instanceof Promise) {
                return result;
            }
            return result;
        }
        return this.executeWithConfig(prInfo, config, _dependencyResults);
    }
    async executeWithConfig(prInfo, config, _dependencyResults) {
        // Extract AI configuration - only set properties that are explicitly provided
        const aiConfig = {};
        // Check-level AI configuration (ai object)
        if (config.ai) {
            // Only set properties that are actually defined to avoid overriding env vars
            if (config.ai.apiKey !== undefined) {
                aiConfig.apiKey = config.ai.apiKey;
            }
            if (config.ai.model !== undefined) {
                aiConfig.model = config.ai.model;
            }
            if (config.ai.timeout !== undefined) {
                aiConfig.timeout = config.ai.timeout;
            }
            if (config.ai.provider !== undefined) {
                aiConfig.provider = config.ai.provider;
            }
            if (config.ai.debug !== undefined) {
                aiConfig.debug = config.ai.debug;
            }
        }
        // Check-level AI model and provider (top-level properties)
        if (config.ai_model !== undefined) {
            aiConfig.model = config.ai_model;
        }
        if (config.ai_provider !== undefined) {
            aiConfig.provider = config.ai_provider;
        }
        // Get custom prompt from config - REQUIRED, no fallbacks
        const customPrompt = config.prompt;
        if (!customPrompt) {
            throw new Error(`No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`);
        }
        // Process prompt with Liquid templates and file loading
        const processedPrompt = await this.processPrompt(customPrompt, prInfo, config.eventContext, _dependencyResults);
        // Create AI service with config - environment variables will be used if aiConfig is empty
        const service = new ai_review_service_1.AIReviewService(aiConfig);
        console.error(`🔧 Debug: AICheckProvider using processed prompt: ${processedPrompt.substring(0, 100)}...`);
        // Pass the custom prompt and schema - no fallbacks
        const schema = config.schema;
        console.error(`🔧 Debug: AICheckProvider schema from config: ${JSON.stringify(schema)}`);
        console.error(`🔧 Debug: AICheckProvider full config: ${JSON.stringify(config, null, 2)}`);
        try {
            return await service.executeReview(prInfo, processedPrompt, schema);
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Log detailed error information
            console.error(`❌ AI Check Provider Error for check: ${errorMessage}`);
            // Check if this is a critical error (authentication, rate limits, etc)
            const isCriticalError = errorMessage.includes('API rate limit') ||
                errorMessage.includes('403') ||
                errorMessage.includes('401') ||
                errorMessage.includes('authentication') ||
                errorMessage.includes('API key');
            if (isCriticalError) {
                console.error(`🚨 CRITICAL ERROR: AI provider authentication or rate limit issue detected`);
                console.error(`🚨 This check cannot proceed without valid API credentials`);
            }
            // Re-throw with more context
            throw new Error(`AI analysis failed: ${errorMessage}`);
        }
    }
    getSupportedConfigKeys() {
        return [
            'type',
            'prompt',
            'focus',
            'schema',
            'group',
            'ai.provider',
            'ai.model',
            'ai.apiKey',
            'ai.timeout',
            'ai_model',
            'ai_provider',
            'env',
        ];
    }
    async isAvailable() {
        // Check if any AI API key is available
        return !!(process.env.GOOGLE_API_KEY ||
            process.env.ANTHROPIC_API_KEY ||
            process.env.OPENAI_API_KEY);
    }
    getRequirements() {
        return [
            'At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY',
            'Optional: MODEL_NAME environment variable',
            'Network access to AI provider APIs',
        ];
    }
}
exports.AICheckProvider = AICheckProvider;
//# sourceMappingURL=ai-check-provider.js.map