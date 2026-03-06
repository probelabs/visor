import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
// eslint-disable-next-line no-restricted-imports -- needed for Liquid type
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { EnvironmentResolver } from '../utils/env-resolver';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { buildProviderTemplateContext } from '../utils/template-context';
import { OAuth2TokenCache, AuthConfig } from '../utils/oauth2-token-cache';
import Sandbox from '@nyariv/sandboxjs';
import { logger } from '../logger';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Check provider that fetches data from HTTP endpoints
 */
export class HttpClientProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox?: Sandbox;

  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }

  private createSecureSandbox(): Sandbox {
    return createSecureSandbox();
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

    // Must have either `url` or `base_url` specified
    const hasUrl = typeof cfg.url === 'string' && cfg.url;
    const hasBaseUrl = typeof cfg.base_url === 'string' && cfg.base_url;

    if (!hasUrl && !hasBaseUrl) {
      return false;
    }

    // Validate URL format (check whichever is provided)
    try {
      new URL((hasUrl ? cfg.url : cfg.base_url) as string);
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
    const baseUrl = config.base_url as string | undefined;
    const rawPath = config.path as string | undefined;
    const pathParams = (config.params as Record<string, string>) || {};
    const queryParams = (config.query as Record<string, string>) || {};
    const authConfig = config.auth as AuthConfig | undefined;

    // Build URL: either direct `url` or `base_url` + `path` with param substitution
    let url: string;
    if (baseUrl && rawPath) {
      // Substitute {param} placeholders in path
      let resolvedPath = rawPath;
      for (const [key, value] of Object.entries(pathParams)) {
        resolvedPath = resolvedPath.replace(`{${key}}`, encodeURIComponent(value));
      }
      url = `${baseUrl.replace(/\/+$/, '')}/${resolvedPath.replace(/^\/+/, '')}`;
      // Append query parameters
      if (Object.keys(queryParams).length > 0) {
        const qs = new URLSearchParams(queryParams).toString();
        url += `${url.includes('?') ? '&' : '?'}${qs}`;
      }
    } else {
      url = config.url as string;
    }

    const method = (config.method as string) || 'GET';
    const headers = (config.headers as Record<string, string>) || {};
    const timeout = (config.timeout as number) || 30000;
    const transform = config.transform as string | undefined;
    const transformJs = config.transform_js as string | undefined;
    const outputFileTemplate = config.output_file as string | undefined;
    const skipIfExists = config.skip_if_exists !== false; // Default true for caching

    // Track resolved URL for error messages
    let resolvedUrlForErrors = url;

    try {
      // Use shared template context builder for consistent output extraction
      const templateContext = buildProviderTemplateContext(
        prInfo,
        dependencyResults,
        undefined, // memoryStore
        undefined, // outputHistory
        undefined, // stageHistoryBase
        { attachMemoryReadHelpers: false }
      );
      // Add env to context for shell-style variable resolution
      (templateContext as Record<string, unknown>).env = process.env;

      // First resolve shell-style environment variables (${VAR}, $VAR, ${{ env.VAR }})
      let renderedUrl = String(EnvironmentResolver.resolveValue(url));
      resolvedUrlForErrors = renderedUrl; // Track for error messages

      // Then render Liquid templates if present
      if (renderedUrl.includes('{{') || renderedUrl.includes('{%')) {
        renderedUrl = await this.liquid.parseAndRender(renderedUrl, templateContext);
        resolvedUrlForErrors = renderedUrl; // Update after Liquid rendering
      }

      // Prepare request body — supports both Liquid template strings and JSON objects
      let requestBody: string | undefined;
      const rawBody = config.body;
      const bodyTemplate = typeof rawBody === 'string' ? rawBody : undefined;
      if (rawBody && typeof rawBody === 'object') {
        requestBody = JSON.stringify(rawBody);
      } else if (bodyTemplate) {
        // First resolve shell-style environment variables
        let resolvedBody = String(EnvironmentResolver.resolveValue(bodyTemplate));
        // Then render Liquid templates if present
        if (resolvedBody.includes('{{') || resolvedBody.includes('{%')) {
          resolvedBody = await this.liquid.parseAndRender(resolvedBody, templateContext);
        }
        requestBody = resolvedBody;
      }

      // Resolve environment variables and Liquid templates in headers
      const resolvedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        let resolvedValue = String(EnvironmentResolver.resolveValue(value));
        // Render Liquid templates if present
        if (resolvedValue.includes('{{') || resolvedValue.includes('{%')) {
          resolvedValue = await this.liquid.parseAndRender(resolvedValue, templateContext);
        }
        resolvedHeaders[key] = resolvedValue;
        // Debug auth header (mask most of the value for security)
        if (key.toLowerCase() === 'authorization') {
          const maskedValue =
            resolvedValue.length > 20
              ? `${resolvedValue.substring(0, 15)}...${resolvedValue.substring(resolvedValue.length - 5)}`
              : resolvedValue;
          logger.verbose(`[http_client] ${key}: ${maskedValue}`);
        }
      }

      // Inject OAuth2 Bearer token if auth config is provided
      if (authConfig?.type === 'oauth2_client_credentials') {
        const tokenCache = OAuth2TokenCache.getInstance();
        const token = await tokenCache.getToken(authConfig);
        resolvedHeaders['Authorization'] = `Bearer ${token}`;
      }

      // Resolve output_file path if specified
      let resolvedOutputFile: string | undefined;
      if (outputFileTemplate) {
        let outputPath = String(EnvironmentResolver.resolveValue(outputFileTemplate));
        if (outputPath.includes('{{') || outputPath.includes('{%')) {
          outputPath = await this.liquid.parseAndRender(outputPath, templateContext);
        }
        resolvedOutputFile = outputPath.trim();

        // When workspace is enabled and path is relative, resolve against workingDirectory
        const parentContext = (context as any)?._parentContext;
        const workingDirectory = parentContext?.workingDirectory;
        const workspaceEnabled = parentContext?.workspace?.isEnabled?.();

        if (workspaceEnabled && workingDirectory && !path.isAbsolute(resolvedOutputFile)) {
          resolvedOutputFile = path.join(workingDirectory, resolvedOutputFile);
          logger.debug(
            `[http_client] Resolved relative output_file to workspace: ${resolvedOutputFile}`
          );
        }

        // Check if file already exists (caching)
        if (skipIfExists && fs.existsSync(resolvedOutputFile)) {
          const stats = fs.statSync(resolvedOutputFile);
          logger.verbose(`[http_client] File cached: ${resolvedOutputFile} (${stats.size} bytes)`);
          return {
            issues: [],
            file_path: resolvedOutputFile,
            size: stats.size,
            cached: true,
          } as unknown as ReviewSummary;
        }
      }

      // Test hook: mock HTTP response for this step
      const stepName = (config as any).checkName || 'unknown';
      const mock = context?.hooks?.mockForStep?.(String(stepName));

      // If mock is provided, return it directly as the step output (with issues: [])
      if (mock !== undefined) {
        const mockObj = typeof mock === 'object' && mock !== null ? mock : { data: mock };
        return {
          issues: [],
          ...mockObj,
        } as unknown as ReviewSummary & { data: unknown };
      }

      // Debug log the request for troubleshooting
      logger.verbose(`[http_client] ${method} ${renderedUrl}`);
      if (requestBody) {
        logger.verbose(
          `[http_client] Body: ${requestBody.substring(0, 500)}${requestBody.length > 500 ? '...' : ''}`
        );
      }

      // If output_file is specified, download to file instead of returning data
      if (resolvedOutputFile) {
        const fileResult = await this.downloadToFile(
          renderedUrl,
          method,
          resolvedHeaders,
          requestBody,
          timeout,
          resolvedOutputFile
        );
        return fileResult;
      }

      const data = await this.fetchData(renderedUrl, method, resolvedHeaders, requestBody, timeout);

      // Apply Liquid transformation if specified
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

      // Apply JavaScript transformation if specified
      if (transformJs) {
        try {
          this.sandbox = this.createSecureSandbox();

          // Create scope for JavaScript transform (scope, not context)
          const jsScope: Record<string, unknown> = {
            output: data,
            pr: templateContext.pr,
            outputs: templateContext.outputs,
            env: process.env,
          };

          const result = compileAndRun(this.sandbox, transformJs, jsScope, {
            injectLog: true,
            logPrefix: '🔍 [transform_js]',
            wrapFunction: true,
          });
          processedData = result;
          logger.verbose(`✓ Applied JavaScript transform successfully`);
        } catch (error) {
          logger.error(
            `✗ Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
          return {
            issues: [
              {
                file: 'http_client',
                line: 0,
                ruleId: 'http_client/transform_js_error',
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Return the fetched data in the standard `output` property for guarantee evaluation
      // This is consistent with other providers (script, command, ai, etc.)
      return {
        issues: [],
        output: processedData,
      } as unknown as ReviewSummary;
    } catch (error) {
      return {
        issues: [
          {
            file: 'http_client',
            line: 0,
            ruleId: 'http_client/fetch_error',
            message: `Failed to fetch from ${resolvedUrlForErrors}: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

      logger.verbose(`[http_client] Response: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        // Log response body for debugging auth failures
        try {
          const errorBody = await response.text();
          logger.warn(`[http_client] Error body: ${errorBody.substring(0, 500)}`);
        } catch {}
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

  private async downloadToFile(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeout: number,
    outputFile: string
  ): Promise<ReviewSummary> {
    // Check if fetch is available (Node 18+)
    if (typeof fetch === 'undefined') {
      throw new Error('HTTP client provider requires Node.js 18+ or node-fetch package');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestOptions: RequestInit = {
        method,
        headers: { ...headers },
        signal: controller.signal,
      };

      // Add body for non-GET requests
      if (method !== 'GET' && body) {
        requestOptions.body = body;
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
        return {
          issues: [
            {
              file: 'http_client',
              line: 0,
              ruleId: 'http_client/download_error',
              message: `Failed to download file: HTTP ${response.status}: ${response.statusText}`,
              severity: 'error',
              category: 'logic',
            },
          ],
        };
      }

      // Create parent directory if it doesn't exist
      const parentDir = path.dirname(outputFile);
      if (parentDir && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Get the response as an ArrayBuffer and write to file
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      fs.writeFileSync(outputFile, buffer);

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      logger.verbose(`[http_client] Downloaded: ${outputFile} (${buffer.length} bytes)`);

      return {
        issues: [],
        file_path: outputFile,
        size: buffer.length,
        content_type: contentType,
        cached: false,
      } as unknown as ReviewSummary;
    } catch (error: unknown) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          issues: [
            {
              file: 'http_client',
              line: 0,
              ruleId: 'http_client/download_timeout',
              message: `Download timed out after ${timeout}ms`,
              severity: 'error',
              category: 'logic',
            },
          ],
        };
      }

      return {
        issues: [
          {
            file: 'http_client',
            line: 0,
            ruleId: 'http_client/download_error',
            message: `Failed to download file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'url',
      'base_url',
      'path',
      'params',
      'query',
      'auth',
      'method',
      'headers',
      'body',
      'transform',
      'transform_js',
      'timeout',
      'output_file',
      'skip_if_exists',
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
      'Optional: output_file path to download response to a file',
      'Optional: skip_if_exists (default: true) to enable caching for file downloads',
    ];
  }
}
