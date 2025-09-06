"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AIReviewService = void 0;
const child_process_1 = require("child_process");
class AIReviewService {
    config;
    constructor(config = {}) {
        this.config = {
            timeout: 600000, // Increased timeout to 10 minutes for AI responses
            ...config,
        };
        // Auto-detect provider and API key from environment
        if (!this.config.apiKey) {
            if (process.env.GOOGLE_API_KEY) {
                this.config.apiKey = process.env.GOOGLE_API_KEY;
                this.config.provider = 'google';
            }
            else if (process.env.ANTHROPIC_API_KEY) {
                this.config.apiKey = process.env.ANTHROPIC_API_KEY;
                this.config.provider = 'anthropic';
            }
            else if (process.env.OPENAI_API_KEY) {
                this.config.apiKey = process.env.OPENAI_API_KEY;
                this.config.provider = 'openai';
            }
        }
        // Auto-detect model from environment
        if (!this.config.model && process.env.MODEL_NAME) {
            this.config.model = process.env.MODEL_NAME;
        }
    }
    /**
     * Execute AI review using probe-chat
     */
    async executeReview(prInfo, focus) {
        const startTime = Date.now();
        const timestamp = new Date().toISOString();
        const prompt = this.buildPrompt(prInfo, focus);
        console.log(`Executing AI review with ${this.config.provider} provider...`);
        let debugInfo;
        if (this.config.debug) {
            debugInfo = {
                prompt,
                rawResponse: '',
                provider: this.config.provider || 'unknown',
                model: this.config.model || 'default',
                apiKeySource: this.getApiKeySource(),
                processingTime: 0,
                promptLength: prompt.length,
                responseLength: 0,
                errors: [],
                jsonParseSuccess: false,
                timestamp,
            };
        }
        // Check if API key is available
        if (!this.config.apiKey) {
            const errorMessage = 'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY environment variable.';
            // In debug mode, return a review with the error captured
            if (debugInfo) {
                debugInfo.errors = [errorMessage];
                debugInfo.processingTime = Date.now() - startTime;
                debugInfo.rawResponse = 'API call not attempted - no API key configured';
                return {
                    issues: [{
                            file: 'system',
                            line: 0,
                            ruleId: 'system/api-key-missing',
                            message: errorMessage,
                            severity: 'error',
                            category: 'logic'
                        }],
                    suggestions: ['Configure API keys in your GitHub repository secrets or environment variables'],
                    debug: debugInfo
                };
            }
            throw new Error(errorMessage);
        }
        try {
            const response = await this.callProbeChat(prompt);
            const processingTime = Date.now() - startTime;
            if (debugInfo) {
                debugInfo.rawResponse = response;
                debugInfo.responseLength = response.length;
                debugInfo.processingTime = processingTime;
            }
            const result = this.parseAIResponse(response, debugInfo);
            if (debugInfo) {
                result.debug = debugInfo;
            }
            return result;
        }
        catch (error) {
            if (debugInfo) {
                debugInfo.errors = [error instanceof Error ? error.message : String(error)];
                debugInfo.processingTime = Date.now() - startTime;
                // In debug mode, return a review with the error captured
                return {
                    issues: [{
                            file: 'system',
                            line: 0,
                            ruleId: 'system/ai-execution-error',
                            message: error instanceof Error ? error.message : String(error),
                            severity: 'error',
                            category: 'logic'
                        }],
                    suggestions: ['Check AI service configuration and API key validity'],
                    debug: debugInfo
                };
            }
            throw error;
        }
    }
    /**
     * Build the prompt for AI review with XML-formatted data
     */
    buildPrompt(prInfo, focus) {
        const focusInstructions = this.getFocusInstructions(focus);
        const prContext = this.formatPRContext(prInfo);
        const analysisType = prInfo.commitDiff ? 'INCREMENTAL' : 'FULL';
        return `${focusInstructions}

ANALYSIS TYPE: ${analysisType}
${analysisType === 'INCREMENTAL'
            ? '- You are analyzing a new commit added to an existing PR. Focus on the <commit_diff> section for changes made in this specific commit.'
            : '- You are analyzing the complete PR. Review all changes in the <full_diff> section.'}

CRITICAL: You must respond with ONLY valid JSON. Do not include any explanations, markdown formatting, or text outside the JSON object. If you cannot analyze the code, return an empty issues array, but always return valid JSON.

Analyze the following structured pull request data:

${prContext}

Key instructions for XML data analysis:
1. The PR metadata provides context (title, description, author, etc.)
2. If <full_diff> is present: Review the entire PR changes
3. If <commit_diff> is present: Focus on incremental changes from the latest commit
4. Use <files_summary> for understanding the scope of changes
5. Line numbers in your response should reference the diff context lines (starting with + or -)

Required JSON response format:
{
  "issues": [{
    "file": "<filename from the diff>",
    "line": <line number in the file>,
    "endLine": <optional end line for multi-line issues>,
    "ruleId": "<category>/<specific-issue-type>",
    "message": "<description of the issue>",
    "severity": "<info|warning|error|critical>",
    "category": "<security|performance|style|logic|documentation>",
    "suggestion": "<clear actionable explanation of how to fix the issue>",
    "replacement": "<complete working code that should replace the problematic lines>"
  }],
  "suggestions": ["<general suggestions not tied to specific lines>"]
}

Field Guidelines:
- "suggestion": Provide a clear, concise explanation of HOW to fix the issue (e.g., "Use const instead of let for immutable values", "Add input validation before using user data")
- "replacement": Provide the EXACT code that should replace the problematic lines. The code must be:
  * Complete and syntactically correct
  * Properly indented to match the surrounding code
  * A working solution that can be directly copy-pasted
  * Include minimal necessary context (usually just the fixed line(s))

Code Replacement Examples:

Example 1 - Variable declaration:
  message: "Variable 'userName' is never reassigned"
  suggestion: "Use const for variables that are never reassigned"
  replacement: "const userName = getUserName();"

Example 2 - SQL Injection:
  message: "SQL query is vulnerable to injection attacks"
  suggestion: "Use parameterized queries to prevent SQL injection"
  replacement: "const query = 'SELECT * FROM users WHERE id = ?';\nconst result = await db.query(query, [userId]);"

Example 3 - Missing error handling:
  message: "Promise rejection is not handled"
  suggestion: "Add try-catch block to handle potential errors"
  replacement: "try {\n  const data = await fetchData();\n  return data;\n} catch (error) {\n  console.error('Failed to fetch data:', error);\n  throw error;\n}"

Severity levels:
- "info": Low priority informational issues (e.g., minor style suggestions, optional improvements)
- "warning": Medium priority issues that should be addressed (e.g., code smells, minor bugs)
- "error": High priority issues that need fixing (e.g., significant bugs, major design problems)
- "critical": Critical issues that must be fixed immediately (e.g., security vulnerabilities, data loss risks)

RuleId format: "category/specific-type" (e.g., "security/sql-injection", "performance/n-plus-one", "style/naming-convention")

IMPORTANT: Only analyze changes marked with + (additions) or context around - (deletions) in the diff. Ignore unchanged code unless it's relevant to understanding a new change.`;
    }
    /**
     * Get focus-specific instructions
     */
    getFocusInstructions(focus) {
        switch (focus) {
            case 'security':
                return 'Review this code for security issues like SQL injection, hardcoded secrets, authentication problems, and input validation flaws.';
            case 'performance':
                return 'Review this code for performance issues like inefficient algorithms, database query problems, and memory usage concerns.';
            case 'style':
                return 'Review this code for style and quality issues like naming conventions, formatting, consistency, and best practices.';
            case 'all':
            default:
                return 'Review this code for security vulnerabilities, performance issues, style problems, logic errors, and documentation quality.';
        }
    }
    /**
     * Format PR context for the AI using XML structure
     */
    formatPRContext(prInfo) {
        let context = `<pull_request>
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <base_branch>${prInfo.base}</base_branch>
    <target_branch>${prInfo.head}</target_branch>
    <total_additions>${prInfo.totalAdditions}</total_additions>
    <total_deletions>${prInfo.totalDeletions}</total_deletions>
    <files_changed_count>${prInfo.files.length}</files_changed_count>
  </metadata>`;
        // Add PR description if available
        if (prInfo.body) {
            context += `
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
        }
        // Add full diff if available (for complete PR review)
        if (prInfo.fullDiff) {
            context += `
  <full_diff>
${this.escapeXml(prInfo.fullDiff)}
  </full_diff>`;
        }
        // Add incremental commit diff if available (for new commit analysis)
        if (prInfo.commitDiff) {
            context += `
  <commit_diff>
${this.escapeXml(prInfo.commitDiff)}
  </commit_diff>`;
        }
        // Add file summary for context
        if (prInfo.files.length > 0) {
            context += `
  <files_summary>`;
            prInfo.files.forEach((file, index) => {
                context += `
    <file index="${index + 1}">
      <filename>${this.escapeXml(file.filename)}</filename>
      <status>${file.status}</status>
      <additions>${file.additions}</additions>
      <deletions>${file.deletions}</deletions>
    </file>`;
            });
            context += `
  </files_summary>`;
        }
        context += `
</pull_request>`;
        return context;
    }
    /**
     * Escape XML special characters
     */
    escapeXml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
    /**
     * Call probe-chat CLI tool using stdin to avoid shell escaping issues
     */
    async callProbeChat(prompt) {
        console.log('🤖 Calling probe-chat for AI review...');
        console.log(`📝 Prompt length: ${prompt.length} characters`);
        console.log(`⚙️ Model: ${this.config.model || 'default'}, Provider: ${this.config.provider || 'auto'}`);
        return new Promise((resolve, reject) => {
            const env = {
                ...process.env,
            };
            // Set API key based on provider
            if (this.config.provider === 'google' && this.config.apiKey) {
                env.GOOGLE_API_KEY = this.config.apiKey;
                console.log('🔑 Using Google API key');
            }
            else if (this.config.provider === 'anthropic' && this.config.apiKey) {
                env.ANTHROPIC_API_KEY = this.config.apiKey;
                console.log('🔑 Using Anthropic API key');
            }
            else if (this.config.provider === 'openai' && this.config.apiKey) {
                env.OPENAI_API_KEY = this.config.apiKey;
                console.log('🔑 Using OpenAI API key');
            }
            // Set model if specified
            if (this.config.model) {
                env.MODEL_NAME = this.config.model;
                console.log(`🎯 Using model: ${this.config.model}`);
            }
            console.log('🚀 Spawning probe-chat process...');
            // Use stdin instead of -m flag to avoid shell escaping issues
            const child = (0, child_process_1.spawn)('npx', ['-y', '@buger/probe-chat@latest', '--json'], {
                env,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'], // Enable stdin, stdout, stderr
            });
            let output = '';
            let error = '';
            let isResolved = false;
            child.stdout.on('data', data => {
                const chunk = data.toString();
                output += chunk;
                console.log('📤 Received stdout chunk:', chunk.substring(0, 200) + (chunk.length > 200 ? '...' : ''));
            });
            child.stderr.on('data', data => {
                const chunk = data.toString();
                error += chunk;
                console.log('⚠️ Received stderr:', chunk);
            });
            child.on('error', err => {
                if (!isResolved) {
                    isResolved = true;
                    console.error('❌ Process error:', err.message);
                    reject(new Error(`Failed to spawn probe-chat: ${err.message}`));
                }
            });
            // Write prompt to stdin and close it
            try {
                console.log('📝 Writing prompt to stdin...');
                child.stdin.write(prompt, 'utf8');
                child.stdin.end();
                console.log('✅ Prompt written to stdin and closed');
            }
            catch (err) {
                if (!isResolved) {
                    isResolved = true;
                    console.error('❌ Error writing to stdin:', err);
                    reject(new Error(`Failed to write prompt to stdin: ${err instanceof Error ? err.message : 'Unknown error'}`));
                }
                return;
            }
            // Set timeout
            const timeout = setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    console.error('⏰ AI review timed out after', this.config.timeout || 30000, 'ms');
                    child.kill('SIGKILL');
                    reject(new Error(`AI review timed out after ${this.config.timeout || 30000}ms`));
                }
            }, this.config.timeout || 30000);
            child.on('close', (code, signal) => {
                clearTimeout(timeout);
                if (!isResolved) {
                    isResolved = true;
                    console.log(`🏁 Process closed with code: ${code}, signal: ${signal}`);
                    console.log(`📤 Final output length: ${output.length} characters`);
                    console.log(`⚠️ Final error length: ${error.length} characters`);
                    if (code === 0) {
                        console.log('✅ probe-chat completed successfully');
                        resolve(output.trim());
                    }
                    else {
                        console.error('❌ probe-chat failed with code:', code);
                        console.error('❌ Error output:', error);
                        reject(new Error(`probe-chat exited with code ${code}: ${error || 'No error details available'}`));
                    }
                }
            });
        });
    }
    /**
     * Parse AI response JSON
     */
    parseAIResponse(response, debugInfo) {
        console.log('🔍 Parsing AI response...');
        console.log(`📊 Raw response length: ${response.length} characters`);
        // Log first and last 200 chars for debugging
        if (response.length > 400) {
            console.log('📋 Response preview (first 200 chars):', response.substring(0, 200));
            console.log('📋 Response preview (last 200 chars):', response.substring(response.length - 200));
        }
        else {
            console.log('📋 Full response preview:', response);
        }
        try {
            // First, try to parse as probe-chat response wrapper
            let probeChatResponse;
            try {
                probeChatResponse = JSON.parse(response);
                console.log('✅ Successfully parsed probe-chat JSON wrapper');
                if (debugInfo)
                    debugInfo.jsonParseSuccess = true;
            }
            catch (initialError) {
                console.log('🔍 Initial parsing failed, trying to extract JSON from response...');
                // If the response starts with "I cannot" or similar, it's likely a refusal
                if (response.toLowerCase().includes('i cannot') ||
                    response.toLowerCase().includes('unable to')) {
                    console.error('🚫 AI refused to analyze - returning empty result');
                    return {
                        issues: [],
                        suggestions: [
                            'AI was unable to analyze this code. Please check the content or try again.',
                        ],
                    };
                }
                // Check if response is plain text and doesn't contain structured data
                if (!response.includes('{') && !response.includes('}')) {
                    console.log('🔧 Plain text response detected, creating structured fallback...');
                    // Create a fallback response based on the plain text
                    const isNoChanges = response.toLowerCase().includes('no') &&
                        (response.toLowerCase().includes('changes') || response.toLowerCase().includes('code'));
                    return {
                        issues: [],
                        suggestions: isNoChanges
                            ? ['No code changes detected in this analysis']
                            : [`AI response: ${response.substring(0, 200)}${response.length > 200 ? '...' : ''}`],
                    };
                }
                // Try to find JSON within the response
                const jsonMatches = response.match(/\{[\s\S]*\}/g);
                if (jsonMatches && jsonMatches.length > 0) {
                    console.log('🔧 Found potential JSON in response, attempting to parse...');
                    // Try the largest JSON-like string (likely the complete response)
                    const largestJson = jsonMatches.reduce((a, b) => (a.length > b.length ? a : b));
                    console.log('🔧 Attempting to parse extracted JSON...');
                    probeChatResponse = { response: largestJson };
                }
                else {
                    // Re-throw the original error if we can't find JSON
                    throw initialError;
                }
            }
            // Extract the actual review from the response field
            let reviewData;
            if (probeChatResponse.response) {
                console.log('📝 Found response field in probe-chat output');
                const aiResponse = probeChatResponse.response;
                // Log the AI response for debugging
                console.log('🤖 AI response content:', aiResponse.substring(0, 300) + (aiResponse.length > 300 ? '...' : ''));
                // The response might be wrapped in markdown code blocks
                const cleanResponse = aiResponse
                    .replace(/^```json\n?/, '')
                    .replace(/\n?```$/, '')
                    .trim();
                console.log('🧹 Cleaned response:', cleanResponse.substring(0, 300) + (cleanResponse.length > 300 ? '...' : ''));
                // Try to parse the cleaned response as JSON
                try {
                    reviewData = JSON.parse(cleanResponse);
                    console.log('✅ Successfully parsed AI review JSON');
                    if (debugInfo)
                        debugInfo.jsonParseSuccess = true;
                }
                catch (parseError) {
                    console.error('❌ Failed to parse AI review JSON:', parseError);
                    console.error('🔍 Attempting fallback parsing strategies...');
                    // Check if the AI response is plain text without JSON structure
                    if (!cleanResponse.includes('{') && !cleanResponse.includes('}')) {
                        console.log('🔧 Plain text AI response detected, creating structured fallback...');
                        const isNoChanges = cleanResponse.toLowerCase().includes('no') &&
                            (cleanResponse.toLowerCase().includes('changes') ||
                                cleanResponse.toLowerCase().includes('code'));
                        reviewData = {
                            issues: [],
                            suggestions: isNoChanges
                                ? ['No code changes detected in this analysis']
                                : [
                                    `AI response: ${cleanResponse.substring(0, 200)}${cleanResponse.length > 200 ? '...' : ''}`,
                                ],
                        };
                        console.log('✅ Created structured fallback from plain text response');
                    }
                    else {
                        // Try to extract JSON from anywhere in the response
                        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            console.log('🔧 Found JSON pattern, attempting to parse...');
                            reviewData = JSON.parse(jsonMatch[0]);
                            console.log('✅ Successfully parsed JSON from pattern match');
                            if (debugInfo)
                                debugInfo.jsonParseSuccess = true;
                        }
                        else {
                            throw parseError;
                        }
                    }
                }
            }
            else if (probeChatResponse.overallScore !== undefined) {
                // Direct response without wrapper
                console.log('📦 Direct response format detected');
                reviewData = probeChatResponse;
            }
            else {
                console.error('❌ No response field found and not direct format');
                console.error('🔍 Available fields:', Object.keys(probeChatResponse));
                throw new Error('Invalid probe-chat response format: no response field found');
            }
            // Validate the parsed data
            console.log('🔍 Validating parsed review data...');
            console.log(`📊 Overall score: ${0}`);
            console.log(`📋 Total issues: ${reviewData.issues?.length || 0}`);
            console.log(`🚨 Critical issues: ${reviewData.issues?.filter((i) => i.severity === 'critical').length || 0}`);
            console.log(`💡 Suggestions count: ${Array.isArray(reviewData.suggestions) ? reviewData.suggestions.length : 0}`);
            console.log(`💬 Comments count: ${Array.isArray(reviewData.issues) ? reviewData.issues.length : 0}`);
            // Process issues from the simplified format
            const processedIssues = Array.isArray(reviewData.issues)
                ? reviewData.issues.map((issue, index) => {
                    console.log(`🔍 Processing issue ${index + 1}:`, issue);
                    return {
                        file: issue.file || 'unknown',
                        line: issue.line || 1,
                        endLine: issue.endLine,
                        ruleId: issue.ruleId || `${issue.category || 'general'}/unknown`,
                        message: issue.message || '',
                        severity: this.validateSeverity(issue.severity),
                        category: this.validateCategory(issue.category),
                        suggestion: issue.suggestion,
                        replacement: issue.replacement,
                    };
                })
                : [];
            // Validate and convert to ReviewSummary format
            const result = {
                issues: processedIssues,
                suggestions: Array.isArray(reviewData.suggestions) ? reviewData.suggestions : [],
            };
            // Log issue counts
            const criticalCount = result.issues.filter(i => i.severity === 'critical').length;
            if (criticalCount > 0) {
                console.log(`🚨 Found ${criticalCount} critical severity issue(s)`);
            }
            console.log(`📈 Total issues: ${result.issues.length}`);
            console.log('✅ Successfully created ReviewSummary');
            return result;
        }
        catch (error) {
            console.error('❌ Failed to parse AI response:', error);
            console.error('📄 FULL RAW RESPONSE:');
            console.error('='.repeat(80));
            console.error(response);
            console.error('='.repeat(80));
            console.error(`📏 Response length: ${response.length} characters`);
            // Try to provide more helpful error information
            if (error instanceof SyntaxError) {
                console.error('🔍 JSON parsing error - the response may not be valid JSON');
                console.error('🔍 Error details:', error.message);
                // Try to identify where the parsing failed
                const errorMatch = error.message.match(/position (\d+)/);
                if (errorMatch) {
                    const position = parseInt(errorMatch[1]);
                    console.error(`🔍 Error at position ${position}:`);
                    const start = Math.max(0, position - 50);
                    const end = Math.min(response.length, position + 50);
                    console.error(`🔍 Context: "${response.substring(start, end)}"`);
                }
                // Check if response contains common non-JSON patterns
                if (response.includes('I cannot')) {
                    console.error('🔍 Response appears to be a refusal/explanation rather than JSON');
                }
                if (response.includes('```')) {
                    console.error('🔍 Response appears to contain markdown code blocks');
                }
                if (response.startsWith('<')) {
                    console.error('🔍 Response appears to start with XML/HTML');
                }
            }
            throw new Error(`Invalid AI response format: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Validate severity value
     */
    validateSeverity(severity) {
        const valid = ['info', 'warning', 'error', 'critical'];
        if (valid.includes(severity)) {
            return severity;
        }
        // Map common alternatives
        if (severity === 'major' || severity === 'high') {
            return 'error';
        }
        if (severity === 'medium') {
            return 'warning';
        }
        if (severity === 'minor' || severity === 'low') {
            return 'info';
        }
        return 'info';
    }
    /**
     * Validate category value
     */
    validateCategory(category) {
        const valid = ['security', 'performance', 'style', 'logic', 'documentation'];
        if (valid.includes(category)) {
            return category;
        }
        // Map common alternatives
        if (category === 'bug' || category === 'error') {
            return 'logic';
        }
        if (category === 'docs') {
            return 'documentation';
        }
        return 'logic';
    }
    /**
     * Calculate a simple score based on issue severity
     */
    calculateScore(issues) {
        if (issues.length === 0)
            return 100;
        const criticalCount = issues.filter(i => i.severity === 'critical').length;
        const errorCount = issues.filter(i => i.severity === 'error').length;
        const warningCount = issues.filter(i => i.severity === 'warning').length;
        const infoCount = issues.filter(i => i.severity === 'info').length;
        // Deduct points based on severity
        const score = Math.max(0, 100 - criticalCount * 40 - errorCount * 25 - warningCount * 10 - infoCount * 5);
        return score;
    }
    /**
     * Get the API key source for debugging (without revealing the key)
     */
    getApiKeySource() {
        if (process.env.GOOGLE_API_KEY && this.config.provider === 'google') {
            return 'GOOGLE_API_KEY';
        }
        if (process.env.ANTHROPIC_API_KEY && this.config.provider === 'anthropic') {
            return 'ANTHROPIC_API_KEY';
        }
        if (process.env.OPENAI_API_KEY && this.config.provider === 'openai') {
            return 'OPENAI_API_KEY';
        }
        return 'unknown';
    }
}
exports.AIReviewService = AIReviewService;
//# sourceMappingURL=ai-review-service.js.map