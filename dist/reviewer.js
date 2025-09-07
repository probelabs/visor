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
exports.calculateOverallScore = calculateOverallScore;
exports.calculateTotalIssues = calculateTotalIssues;
exports.calculateCriticalIssues = calculateCriticalIssues;
exports.convertIssuesToComments = convertIssuesToComments;
const github_comments_1 = require("./github-comments");
const ai_review_service_1 = require("./ai-review-service");
// Helper functions for calculating metrics from issues
function calculateOverallScore(issues) {
    if (issues.length === 0)
        return 100;
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const errorCount = issues.filter(i => i.severity === 'error').length;
    const warningCount = issues.filter(i => i.severity === 'warning').length;
    const infoCount = issues.filter(i => i.severity === 'info').length;
    return Math.max(0, 100 - criticalCount * 40 - errorCount * 25 - warningCount * 10 - infoCount * 5);
}
function calculateTotalIssues(issues) {
    return issues.length;
}
function calculateCriticalIssues(issues) {
    return issues.filter(i => i.severity === 'critical').length;
}
function convertIssuesToComments(issues) {
    return issues.map(issue => ({
        file: issue.file,
        line: issue.line,
        message: issue.message,
        severity: issue.severity,
        category: issue.category,
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
        const { focus = 'all', format = 'table', debug = false, config, checks, parallelExecution } = options;
        // If we have a config and multiple checks, use CheckExecutionEngine for parallel execution
        if (config && checks && checks.length > 1 && parallelExecution) {
            console.error(`🔧 Debug: PRReviewer using CheckExecutionEngine for parallel execution of ${checks.length} checks`);
            // Import CheckExecutionEngine dynamically to avoid circular dependencies
            const { CheckExecutionEngine } = await Promise.resolve().then(() => __importStar(require('./check-execution-engine')));
            const engine = new CheckExecutionEngine();
            // Execute checks using the engine's parallel execution capability
            const reviewSummary = await engine['executeReviewChecks'](prInfo, checks, undefined, config);
            // Apply format filtering
            return {
                ...reviewSummary,
                issues: format === 'markdown' ? reviewSummary.issues : reviewSummary.issues.slice(0, 5),
            };
        }
        // If debug is enabled, create a new AI service with debug enabled
        if (debug) {
            this.aiReviewService = new ai_review_service_1.AIReviewService({ debug: true });
        }
        // Execute AI review (no fallback) - single check or legacy mode
        const aiReview = await this.aiReviewService.executeReview(prInfo, focus);
        // Apply format filtering
        return {
            ...aiReview,
            issues: format === 'markdown' ? aiReview.issues : aiReview.issues.slice(0, 5),
        };
    }
    async postReviewComment(owner, repo, prNumber, summary, options = {}) {
        const comment = this.formatReviewCommentWithVisorFormat(summary, options);
        await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
            commentId: options.commentId,
            triggeredBy: options.triggeredBy || 'unknown',
            allowConcurrentUpdates: false,
        });
    }
    formatReviewCommentWithVisorFormat(summary, options) {
        const { format = 'table' } = options;
        // Calculate metrics from issues
        const overallScore = calculateOverallScore(summary.issues);
        const totalIssues = calculateTotalIssues(summary.issues);
        const criticalIssues = calculateCriticalIssues(summary.issues);
        const comments = convertIssuesToComments(summary.issues);
        // Create main summary section
        let comment = `# 🔍 Visor Code Review Results\n\n`;
        comment += `## 📊 Summary\n`;
        comment += `- **Overall Score**: ${overallScore}/100\n`;
        comment += `- **Issues Found**: ${totalIssues} (${criticalIssues} Critical, ${totalIssues - criticalIssues} Other)\n`;
        comment += `- **Files Analyzed**: ${new Set(comments.map(c => c.file)).size}\n\n`;
        // Group comments by category for collapsible sections
        const groupedComments = this.groupCommentsByCategory(comments);
        for (const [category, comments] of Object.entries(groupedComments)) {
            const categoryScore = this.calculateCategoryScore(comments);
            const emoji = this.getCategoryEmoji(category);
            const issuesCount = comments.length;
            const title = `${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} Review (Score: ${categoryScore}/100)`;
            let sectionContent = '';
            if (comments.length > 0) {
                sectionContent += `### Issues Found:\n`;
                for (const reviewComment of comments.slice(0, format === 'markdown' ? comments.length : 3)) {
                    sectionContent += `- **${reviewComment.severity.toUpperCase()}**: ${reviewComment.message}\n`;
                    sectionContent += `  - **File**: \`${reviewComment.file}:${reviewComment.line}\`\n\n`;
                }
                if (format === 'table' && comments.length > 3) {
                    sectionContent += `*...and ${comments.length - 3} more issues. Use \`/review --format=markdown\` for complete analysis.*\n\n`;
                }
            }
            else {
                sectionContent += `No issues found in this category. Great job! ✅\n\n`;
            }
            comment += this.commentManager.createCollapsibleSection(title, sectionContent, issuesCount > 0);
            comment += '\n\n';
        }
        // Add suggestions if any
        if (summary.suggestions.length > 0) {
            comment += this.commentManager.createCollapsibleSection('💡 Recommendations', summary.suggestions.map(s => `- ${s}`).join('\n') + '\n', true);
            comment += '\n\n';
        }
        // Add debug section if debug information is available
        if (summary.debug) {
            comment += this.formatDebugSection(summary.debug);
            comment += '\n\n';
        }
        return comment;
    }
    formatReviewComment(summary, options) {
        const { format = 'table' } = options;
        // Calculate metrics from issues
        const overallScore = calculateOverallScore(summary.issues);
        const totalIssues = calculateTotalIssues(summary.issues);
        const criticalIssues = calculateCriticalIssues(summary.issues);
        const comments = convertIssuesToComments(summary.issues);
        let comment = `## 🤖 AI Code Review\n\n`;
        comment += `**Overall Score:** ${overallScore}/100 `;
        if (overallScore >= 80)
            comment += '✅\n';
        else if (overallScore >= 60)
            comment += '⚠️\n';
        else
            comment += '❌\n';
        comment += `**Issues Found:** ${totalIssues} (${criticalIssues} critical)\n\n`;
        if (summary.suggestions.length > 0) {
            comment += `### 💡 Suggestions\n`;
            for (const suggestion of summary.suggestions) {
                comment += `- ${suggestion}\n`;
            }
            comment += '\n';
        }
        if (comments.length > 0) {
            comment += `### 🔍 Code Issues\n`;
            for (const reviewComment of comments) {
                const emoji = reviewComment.severity === 'error'
                    ? '❌'
                    : reviewComment.severity === 'warning'
                        ? '⚠️'
                        : 'ℹ️';
                comment += `${emoji} **${reviewComment.file}:${reviewComment.line}** (${reviewComment.category})\n`;
                comment += `   ${reviewComment.message}\n\n`;
            }
        }
        if (format === 'table' && totalIssues > 5) {
            comment += `*Showing top 5 issues. Use \`/review --format=markdown\` for complete analysis.*\n\n`;
        }
        // Add debug section if debug information is available
        if (summary.debug) {
            comment += this.formatDebugSection(summary.debug);
            comment += '\n\n';
        }
        comment += `---\n*Review powered by Visor - Use \`/help\` for available commands*`;
        return comment;
    }
    groupCommentsByCategory(comments) {
        const grouped = {
            security: [],
            performance: [],
            style: [],
            logic: [],
            documentation: [],
        };
        for (const comment of comments) {
            if (!grouped[comment.category]) {
                grouped[comment.category] = [];
            }
            grouped[comment.category].push(comment);
        }
        return grouped;
    }
    calculateCategoryScore(comments) {
        if (comments.length === 0)
            return 100;
        const errorCount = comments.filter(c => c.severity === 'error').length;
        const warningCount = comments.filter(c => c.severity === 'warning').length;
        const infoCount = comments.filter(c => c.severity === 'info').length;
        return Math.max(0, 100 - errorCount * 25 - warningCount * 10 - infoCount * 5);
    }
    getCategoryEmoji(category) {
        const emojiMap = {
            security: '🔒',
            performance: '📈',
            style: '🎨',
            logic: '🧠',
            documentation: '📚',
        };
        return emojiMap[category] || '📝';
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
        ];
        if (debug.errors && debug.errors.length > 0) {
            formattedContent.push('', '### Errors');
            debug.errors.forEach(error => {
                formattedContent.push(`- ${error}`);
            });
        }
        return this.commentManager.createCollapsibleSection('🐛 Debug Information', formattedContent.join('\n'), false // Start collapsed
        );
    }
}
exports.PRReviewer = PRReviewer;
//# sourceMappingURL=reviewer.js.map