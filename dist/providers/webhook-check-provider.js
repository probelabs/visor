"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookCheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
/**
 * Check provider that sends PR info to a webhook for external analysis
 */
class WebhookCheckProvider extends check_provider_interface_1.CheckProvider {
    getName() {
        return 'webhook';
    }
    getDescription() {
        return 'Send PR data to external webhook for custom analysis';
    }
    async validateConfig(config) {
        if (!config || typeof config !== 'object') {
            return false;
        }
        const cfg = config;
        // Type must be 'webhook'
        if (cfg.type !== 'webhook') {
            return false;
        }
        // Must have URL specified
        if (typeof cfg.url !== 'string' || !cfg.url) {
            return false;
        }
        // Validate URL format
        try {
            new URL(cfg.url);
            return true;
        }
        catch {
            return false;
        }
    }
    async execute(prInfo, config, _dependencyResults, _sessionInfo) {
        const url = config.url;
        const method = config.method || 'POST';
        const headers = config.headers || {};
        const timeout = config.timeout || 30000;
        // Prepare webhook payload
        const payload = {
            title: prInfo.title,
            body: prInfo.body,
            author: prInfo.author,
            base: prInfo.base,
            head: prInfo.head,
            files: prInfo.files.map(f => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch,
            })),
            totalAdditions: prInfo.totalAdditions,
            totalDeletions: prInfo.totalDeletions,
            metadata: config.metadata || {},
        };
        try {
            // Send webhook request
            const response = await this.sendWebhookRequest(url, method, headers, payload, timeout);
            // Parse webhook response
            return this.parseWebhookResponse(response, url);
        }
        catch (error) {
            return this.createErrorResult(url, error);
        }
    }
    async sendWebhookRequest(url, method, headers, payload, timeout) {
        // Check if fetch is available (Node 18+)
        if (typeof fetch === 'undefined') {
            throw new Error('Webhook provider requires Node.js 18+ or node-fetch package');
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
            }
            return (await response.json());
        }
        catch (error) {
            clearTimeout(timeoutId);
            if (error?.name === 'AbortError') {
                throw new Error(`Webhook request timed out after ${timeout}ms`);
            }
            throw error;
        }
    }
    parseWebhookResponse(response, url) {
        // Validate and normalize the webhook response
        if (!response || typeof response !== 'object') {
            return this.createErrorResult(url, new Error('Invalid webhook response format'));
        }
        const issues = Array.isArray(response.comments)
            ? response.comments.map(c => ({
                file: c.file || 'unknown',
                line: c.line || 0,
                endLine: c.endLine,
                ruleId: c.ruleId || `webhook/${this.validateCategory(c.category)}`,
                message: c.message || '',
                severity: this.validateSeverity(c.severity),
                category: this.validateCategory(c.category),
                suggestion: c.suggestion,
                replacement: c.replacement,
            }))
            : [];
        return {
            issues,
            suggestions: Array.isArray(response.suggestions) ? response.suggestions : [],
        };
    }
    createErrorResult(url, error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return {
            issues: [
                {
                    file: 'webhook',
                    line: 0,
                    endLine: undefined,
                    ruleId: 'webhook/error',
                    message: `Webhook execution error: ${errorMessage}`,
                    severity: 'error',
                    category: 'logic',
                    suggestion: undefined,
                    replacement: undefined,
                },
            ],
            suggestions: [`Webhook ${url} failed: ${errorMessage}`],
        };
    }
    validateSeverity(severity) {
        const valid = ['info', 'warning', 'error', 'critical'];
        return valid.includes(severity)
            ? severity
            : 'info';
    }
    validateCategory(category) {
        const valid = ['security', 'performance', 'style', 'logic', 'documentation'];
        return valid.includes(category)
            ? category
            : 'logic';
    }
    getSupportedConfigKeys() {
        return ['type', 'url', 'method', 'headers', 'timeout', 'metadata', 'retryCount', 'retryDelay'];
    }
    async isAvailable() {
        // Webhook is available if fetch is available
        return typeof fetch !== 'undefined';
    }
    getRequirements() {
        return [
            'Valid webhook URL',
            'Network access to webhook endpoint',
            'Webhook must return JSON in ReviewSummary format',
            'Webhook must respond within timeout period',
        ];
    }
}
exports.WebhookCheckProvider = WebhookCheckProvider;
//# sourceMappingURL=webhook-check-provider.js.map