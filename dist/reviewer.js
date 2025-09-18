"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRReviewer = void 0;
exports.convertReviewSummaryToGroupedResults = convertReviewSummaryToGroupedResults;
exports.calculateTotalIssues = calculateTotalIssues;
exports.calculateCriticalIssues = calculateCriticalIssues;
exports.convertIssuesToComments = convertIssuesToComments;
const github_comments_1 = require("./github-comments");
const ai_review_service_1 = require("./ai-review-service");
// Test utility function - Convert old ReviewSummary to new GroupedCheckResults format
// This is for backward compatibility with tests only
function convertReviewSummaryToGroupedResults(reviewSummary, checkName = 'test-check', groupName = 'default') {
    // Create a simple content string from issues and suggestions
    let content = '';
    if (reviewSummary.issues && reviewSummary.issues.length > 0) {
        content += `## Issues Found (${reviewSummary.issues.length})\n\n`;
        reviewSummary.issues.forEach(issue => {
            content += `- **${issue.severity.toUpperCase()}**: ${issue.message} (${issue.file}:${issue.line})\n`;
        });
        content += '\n';
    }
    if (reviewSummary.suggestions && reviewSummary.suggestions.length > 0) {
        content += `## Suggestions\n\n`;
        reviewSummary.suggestions.forEach(suggestion => {
            content += `- ${suggestion}\n`;
        });
    }
    if (!content) {
        content = 'No issues found.';
    }
    const checkResult = {
        checkName,
        content: content.trim(),
        group: groupName,
        debug: reviewSummary.debug,
        issues: reviewSummary.issues, // Include structured issues
    };
    const groupedResults = {};
    groupedResults[groupName] = [checkResult];
    return groupedResults;
}
// Helper functions for GitHub checks - ONLY for structured schemas that have issues
// These are the ONLY acceptable hardcoded schema dependencies, and only for GitHub integration
function calculateTotalIssues(issues) {
    return (issues || []).length;
}
function calculateCriticalIssues(issues) {
    return (issues || []).filter(i => i.severity === 'critical').length;
}
// Legacy converter - ONLY for GitHub integration compatibility
function convertIssuesToComments(issues) {
    return issues.map(issue => ({
        file: issue.file,
        line: issue.line,
        message: issue.message,
        severity: issue.severity,
        category: issue.category,
        suggestion: issue.suggestion,
        replacement: issue.replacement,
        ruleId: issue.ruleId,
    }));
}
class PRReviewer {
    octokit;
    commentManager;
    aiReviewService;
    constructor(octokit) {
        this.octokit = octokit;
        this.commentManager = new github_comments_1.CommentManager(octokit);
        this.aiReviewService = new ai_review_service_1.AIReviewService();
    }
    async reviewPR(owner, repo, prNumber, prInfo, options = {}) {
        const { debug = false, config, checks } = options;
        if (config && checks && checks.length > 0) {
            const { CheckExecutionEngine } = await Promise.resolve().then(() => __importStar(require('./check-execution-engine')));
            const engine = new CheckExecutionEngine();
            const groupedResults = await engine.executeGroupedChecks(prInfo, checks, undefined, config, undefined, debug);
            return groupedResults;
        }
        throw new Error('No configuration provided. Please create a .visor.yaml file with check definitions. ' +
            'Built-in prompts have been removed - all checks must be explicitly configured.');
    }
    async postReviewComment(owner, repo, prNumber, groupedResults, options = {}) {
        // Post separate comments for each group
        for (const [groupName, checkResults] of Object.entries(groupedResults)) {
            const comment = await this.formatGroupComment(checkResults, options, {
                owner,
                repo,
                prNumber,
                commitSha: options.commitSha,
            });
            const commentId = options.commentId
                ? `${options.commentId}-${groupName}`
                : `visor-review-${groupName}`;
            await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
                commentId,
                triggeredBy: options.triggeredBy || 'unknown',
                allowConcurrentUpdates: false,
                commitSha: options.commitSha,
            });
        }
    }
    async formatGroupComment(checkResults, _options, _githubContext) {
        let comment = '';
        comment += `## 🔍 Code Analysis Results\n\n`;
        // Simple concatenation of all check outputs in this group
        const checkContents = checkResults
            .map(result => result.content)
            .filter(content => content.trim());
        comment += checkContents.join('\n\n');
        // Add debug info if any check has it
        const debugInfo = checkResults.find(result => result.debug)?.debug;
        if (debugInfo) {
            comment += '\n\n' + this.formatDebugSection(debugInfo);
            comment += '\n\n';
        }
        comment += `\n---\n*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
        return comment;
    }
    formatDebugSection(debug) {
        const formattedContent = [
            `**Provider:** ${debug.provider}`,
            `**Model:** ${debug.model}`,
            `**API Key Source:** ${debug.apiKeySource}`,
            `**Processing Time:** ${debug.processingTime}ms`,
            `**Timestamp:** ${debug.timestamp}`,
            `**Prompt Length:** ${debug.promptLength} characters`,
            `**Response Length:** ${debug.responseLength} characters`,
            `**JSON Parse Success:** ${debug.jsonParseSuccess ? '✅' : '❌'}`,
        ];
        if (debug.errors && debug.errors.length > 0) {
            formattedContent.push('', '### Errors');
            debug.errors.forEach(error => {
                formattedContent.push(`- ${error}`);
            });
        }
        const fullDebugContent = [
            ...formattedContent,
            '',
            '### AI Prompt',
            '```',
            debug.prompt,
            '```',
            '',
            '### Raw AI Response',
            '```json',
            debug.rawResponse,
            '```',
        ].join('\n');
        if (fullDebugContent.length > 60000) {
            const artifactPath = this.saveDebugArtifact(debug);
            formattedContent.push('');
            formattedContent.push('### Debug Details');
            formattedContent.push('⚠️ Debug information is too large for GitHub comments.');
            if (artifactPath) {
                formattedContent.push(`📁 **Full debug information saved to artifact:** \`${artifactPath}\``);
                formattedContent.push('');
                const runId = process.env.GITHUB_RUN_ID;
                const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
                    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
                    : null;
                if (runId && repoUrl) {
                    formattedContent.push(`🔗 **Download Link:** [visor-debug-${process.env.GITHUB_RUN_NUMBER || runId}](${repoUrl}/actions/runs/${runId})`);
                }
                formattedContent.push('💡 Go to the GitHub Action run above and download the debug artifact to view complete prompts and responses.');
            }
            else {
                formattedContent.push('📝 **Prompt preview:** ' + debug.prompt.substring(0, 500) + '...');
                formattedContent.push('📝 **Response preview:** ' + debug.rawResponse.substring(0, 500) + '...');
            }
        }
        else {
            formattedContent.push('');
            formattedContent.push('### AI Prompt');
            formattedContent.push('```');
            formattedContent.push(debug.prompt);
            formattedContent.push('```');
            formattedContent.push('');
            formattedContent.push('### Raw AI Response');
            formattedContent.push('```json');
            formattedContent.push(debug.rawResponse);
            formattedContent.push('```');
        }
        return this.commentManager.createCollapsibleSection('🐛 Debug Information', formattedContent.join('\n'), false);
    }
    saveDebugArtifact(debug) {
        try {
            const fs = require('fs');
            const path = require('path');
            const debugDir = path.join(process.cwd(), 'debug-artifacts');
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir, { recursive: true });
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `visor-debug-${timestamp}.md`;
            const filepath = path.join(debugDir, filename);
            const content = [
                `# Visor Debug Information`,
                ``,
                `**Timestamp:** ${debug.timestamp}`,
                `**Provider:** ${debug.provider}`,
                `**Model:** ${debug.model}`,
                `**Processing Time:** ${debug.processingTime}ms`,
                ``,
                `## AI Prompt`,
                ``,
                '```',
                debug.prompt,
                '```',
                ``,
                `## Raw AI Response`,
                ``,
                '```json',
                debug.rawResponse,
                '```',
            ].join('\n');
            fs.writeFileSync(filepath, content, 'utf8');
            return filename;
        }
        catch (error) {
            console.error('Failed to save debug artifact:', error);
            return null;
        }
    }
}
exports.PRReviewer = PRReviewer;
//# sourceMappingURL=reviewer.js.map