import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { IssueFilter } from '../issue-filter';

/**
 * Check provider that sends PR info to a webhook for external analysis
 */
export class WebhookCheckProvider extends CheckProvider {
  getName(): string {
    return 'webhook';
  }

  getDescription(): string {
    return 'Send PR data to external webhook for custom analysis';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

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
      new URL(cfg.url as string);
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const url = config.url as string;
    const method = (config.method as string) || 'POST';
    const headers = (config.headers as Record<string, string>) || {};
    const timeout = (config.timeout as number) || 30000;

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
      const result = this.parseWebhookResponse(response, url);

      // Apply issue suppression filtering
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());

      return {
        ...result,
        issues: filteredIssues,
      };
    } catch (error) {
      return this.createErrorResult(url, error);
    }
  }

  private async sendWebhookRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
    timeout: number
  ): Promise<Record<string, unknown>> {
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

      return (await response.json()) as Record<string, unknown>;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Webhook request timed out after ${timeout}ms`);
      }

      throw error;
    }
  }

  private parseWebhookResponse(response: Record<string, unknown>, url: string): ReviewSummary {
    // Validate and normalize the webhook response
    if (!response || typeof response !== 'object') {
      return this.createErrorResult(url, new Error('Invalid webhook response format'));
    }

    const issues: ReviewIssue[] = Array.isArray(response.comments)
      ? (response.comments as Array<Record<string, unknown>>).map(c => ({
          file: (c.file as string) || 'unknown',
          line: (c.line as number) || 0,
          endLine: c.endLine as number | undefined,
          ruleId: (c.ruleId as string) || `webhook/${this.validateCategory(c.category)}`,
          message: (c.message as string) || '',
          severity: this.validateSeverity(c.severity),
          category: this.validateCategory(c.category),
          suggestion: c.suggestion as string | undefined,
          replacement: c.replacement as string | undefined,
        }))
      : [];

    return {
      issues,
      suggestions: Array.isArray(response.suggestions) ? response.suggestions : [],
    };
  }

  private createErrorResult(url: string, error: unknown): ReviewSummary {
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

  private validateSeverity(severity: unknown): 'info' | 'warning' | 'error' | 'critical' {
    const valid = ['info', 'warning', 'error', 'critical'];
    return valid.includes(severity as string)
      ? (severity as 'info' | 'warning' | 'error' | 'critical')
      : 'info';
  }

  private validateCategory(
    category: unknown
  ): 'security' | 'performance' | 'style' | 'logic' | 'documentation' {
    const valid = ['security', 'performance', 'style', 'logic', 'documentation'];
    return valid.includes(category as string)
      ? (category as 'security' | 'performance' | 'style' | 'logic' | 'documentation')
      : 'logic';
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'url', 'method', 'headers', 'timeout', 'metadata', 'retryCount', 'retryDelay'];
  }

  async isAvailable(): Promise<boolean> {
    // Webhook is available if fetch is available
    return typeof fetch !== 'undefined';
  }

  getRequirements(): string[] {
    return [
      'Valid webhook URL',
      'Network access to webhook endpoint',
      'Webhook must return JSON in ReviewSummary format',
      'Webhook must respond within timeout period',
    ];
  }
}
