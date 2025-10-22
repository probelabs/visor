import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { IssueFilter } from '../issue-filter';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { trace, context as otContext } from '../telemetry/lazy-otel';
import {
  captureCheckInputContext,
  captureCheckOutput,
  captureProviderCall,
} from '../telemetry/state-capture';
import { EnvironmentResolver } from '../utils/env-resolver';

/**
 * Check provider that sends data to an HTTP endpoint, typically used as an output/notification provider
 */
export class HttpCheckProvider extends CheckProvider {
  private liquid: Liquid;

  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }
  getName(): string {
    return 'http';
  }

  getDescription(): string {
    return 'Send data to external HTTP endpoint for notifications or integration';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'http'
    if (cfg.type !== 'http') {
      return false;
    }

    // Must have URL specified
    if (typeof cfg.url !== 'string' || !cfg.url) {
      return false;
    }

    // Must have body template specified
    if (typeof cfg.body !== 'string' || !cfg.body) {
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
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const url = config.url as string;
    const bodyTemplate = config.body as string;
    const method = (config.method as string) || 'POST';
    const headers = (config.headers as Record<string, string>) || {};
    const timeout = (config.timeout as number) || 30000;

    // Prepare template context with all available data
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        base: prInfo.base,
        head: prInfo.head,
        totalAdditions: prInfo.totalAdditions,
        totalDeletions: prInfo.totalDeletions,
      },
      files: prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      })),
      outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
      metadata: config.metadata || {},
    };

    // Capture input context in active OTEL span
    try {
      const span = trace.getSpan(otContext.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
      // Ignore telemetry errors
    }

    // Render the body template
    let payload: Record<string, unknown>;
    try {
      const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
      // Try to parse as JSON, otherwise send as plain text
      try {
        payload = JSON.parse(renderedBody);
      } catch {
        payload = { message: renderedBody };
      }
    } catch (error) {
      return this.createErrorResult(
        url,
        new Error(
          `Template rendering failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      );
    }

    try {
      // Resolve environment variables in headers
      const resolvedHeaders = this.resolveHeaders(headers);

      // Send webhook request
      const response = await this.sendWebhookRequest(
        url,
        method,
        resolvedHeaders,
        payload,
        timeout
      );

      // Parse webhook response
      const result = this.parseWebhookResponse(response, url);

      // Apply issue suppression filtering
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());

      const finalResult = {
        ...result,
        issues: filteredIssues,
      };

      // Capture HTTP provider call and output in active OTEL span
      try {
        const span = trace.getSpan(otContext.active());
        if (span) {
          captureProviderCall(
            span,
            'http',
            {
              url,
              method,
              body: JSON.stringify(payload).substring(0, 500),
            },
            {
              content: JSON.stringify(response).substring(0, 500),
            }
          );
          const outputForSpan = (finalResult as { output?: unknown }).output ?? finalResult;
          captureCheckOutput(span, outputForSpan);
        }
      } catch {
        // Ignore telemetry errors
      }

      return finalResult;
    } catch (error) {
      return this.createErrorResult(url, error);
    }
  }

  /**
   * Resolve environment variables in headers
   */
  private resolveHeaders(headers: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] = String(EnvironmentResolver.resolveValue(value));
    }
    return resolved;
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
    return [
      'type',
      'url',
      'body',
      'method',
      'headers',
      'timeout',
      'metadata',
      'depends_on',
      'on',
      'if',
      'group',
      'schedule',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // HTTP provider is available if fetch is available
    return typeof fetch !== 'undefined';
  }

  getRequirements(): string[] {
    return [
      'Valid HTTP URL',
      'Body template (Liquid) for payload construction',
      'Network access to HTTP endpoint',
      'Optional: Dependencies for accessing their outputs in templates',
    ];
  }
}
