import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { EnvironmentResolver } from '../utils/env-resolver';

/**
 * Check provider that fetches data from HTTP endpoints
 */
export class HttpClientProvider extends CheckProvider {
  private liquid: Liquid;

  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }

  getName(): string {
    return 'http_client';
  }

  getDescription(): string {
    return 'Fetch data from HTTP endpoints for use by dependent checks';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'http_client'
    if (cfg.type !== 'http_client') {
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
    dependencyResults?: Map<string, ReviewSummary>,
    context?: import('./check-provider.interface').ExecutionContext
  ): Promise<ReviewSummary> {
    const url = config.url as string;
    const method = (config.method as string) || 'GET';
    const headers = (config.headers as Record<string, string>) || {};
    const timeout = (config.timeout as number) || 30000;
    const transform = config.transform as string | undefined;
    const bodyTemplate = config.body as string | undefined;

    try {
      // Prepare template context for URL and body
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
        outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
        env: process.env,
      };

      // Render URL with template if it contains liquid syntax
      let renderedUrl = url;
      if (url.includes('{{') || url.includes('{%')) {
        renderedUrl = await this.liquid.parseAndRender(url, templateContext);
      }

      // Prepare request body if provided
      let requestBody: string | undefined;
      if (bodyTemplate) {
        const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
        requestBody = renderedBody;
      }

      // Resolve environment variables in headers
      const resolvedHeaders = EnvironmentResolver.resolveHeaders(headers);

      // Test hook: mock HTTP response for this step
      const stepName = (config as any).checkName || 'unknown';
      const mock = context?.hooks?.mockForStep?.(String(stepName));
      const data =
        mock !== undefined
          ? mock
          : await this.fetchData(renderedUrl, method, resolvedHeaders, requestBody, timeout);

      // Apply transformation if specified
      let processedData = data;
      if (transform) {
        try {
          const transformContext = {
            response: data,
            pr: templateContext.pr,
            outputs: templateContext.outputs,
          };
          const rendered = await this.liquid.parseAndRender(transform, transformContext);
          // Try to parse as JSON if the transform result looks like JSON
          if (rendered.trim().startsWith('{') || rendered.trim().startsWith('[')) {
            processedData = JSON.parse(rendered);
          } else {
            processedData = rendered;
          }
        } catch (error) {
          return {
            issues: [
              {
                file: 'http_client',
                line: 0,
                ruleId: 'http_client/transform_error',
                message: `Failed to transform response data: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Return the fetched data as a custom field for dependent checks to access
      return {
        issues: [],
        // Add custom data field that will be passed through to dependent checks
        data: processedData,
      } as ReviewSummary & { data: unknown };
    } catch (error) {
      return {
        issues: [
          {
            file: 'http_client',
            line: 0,
            ruleId: 'http_client/fetch_error',
            message: `Failed to fetch from ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  private async fetchData(
    url: string,
    method: string,
    headers: Record<string, string>,
    body?: string,
    timeout: number = 30000
  ): Promise<unknown> {
    // Check if fetch is available (Node 18+)
    if (typeof fetch === 'undefined') {
      throw new Error('HTTP client provider requires Node.js 18+ or node-fetch package');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestOptions: RequestInit = {
        method,
        headers: {
          ...headers,
        },
        signal: controller.signal,
      };

      // Add body for non-GET requests
      if (method !== 'GET' && body) {
        requestOptions.body = body;
        // Set Content-Type if not already set
        if (!headers['Content-Type'] && !headers['content-type']) {
          requestOptions.headers = {
            ...requestOptions.headers,
            'Content-Type': 'application/json',
          };
        }
      }

      const response = await fetch(url, requestOptions);

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Try to parse as JSON first
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }

      // Otherwise return as text
      const text = await response.text();

      // Try to parse as JSON if it looks like JSON
      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          return JSON.parse(text);
        } catch {
          // Not JSON, return as text
          return text;
        }
      }

      return text;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms`);
      }

      throw error;
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'url',
      'method',
      'headers',
      'body',
      'transform',
      'timeout',
      'depends_on',
      'on',
      'if',
      'group',
      'schedule',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // HTTP client is available if fetch is available
    return typeof fetch !== 'undefined';
  }

  getRequirements(): string[] {
    return [
      'Valid HTTP/HTTPS URL to fetch from',
      'Network access to the endpoint',
      'Optional: Transform template for processing response data',
      'Optional: Body template for POST/PUT requests',
    ];
  }
}
