import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { logger } from '../logger';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { EnvironmentResolver } from '../utils/env-resolver';
import { CustomToolExecutor } from './custom-tool-executor';
import { CustomToolDefinition } from '../types/config';

/**
 * MCP Check Provider Configuration
 */
export interface McpCheckConfig extends CheckProviderConfig {
  /** Transport type: stdio (default), sse (legacy), http (streamable HTTP), or custom (YAML-defined tools) */
  transport?: 'stdio' | 'sse' | 'http' | 'custom';
  /** Command to execute (for stdio transport) */
  command?: string;
  /** Command arguments (for stdio transport) */
  args?: string[];
  /** Environment variables (for stdio transport) */
  env?: Record<string, string>;
  /** Working directory (for stdio transport) */
  workingDirectory?: string;
  /** URL for SSE/HTTP transport */
  url?: string;
  /** HTTP headers (for SSE/HTTP transport) */
  headers?: Record<string, string>;
  /** Session ID for HTTP transport (optional, server may generate one) */
  sessionId?: string;
  /** MCP method/tool to call */
  method: string;
  /** Arguments to pass to the MCP method (supports Liquid templates) */
  methodArgs?: Record<string, unknown>;
  /** Transform template for method arguments (Liquid) */
  argsTransform?: string;
  /** Transform template for output (Liquid) */
  transform?: string;
  /** Transform using JavaScript expressions */
  transform_js?: string;
  /** Timeout in seconds */
  timeout?: number;
}

/**
 * Check provider that calls MCP tools directly
 * Supports stdio, SSE (legacy), Streamable HTTP transports, and custom YAML-defined tools
 */
export class McpCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox?: Sandbox;
  private customToolExecutor?: CustomToolExecutor;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
  }

  /**
   * Set custom tools for this provider
   */
  setCustomTools(tools: Record<string, CustomToolDefinition>): void {
    if (!this.customToolExecutor) {
      this.customToolExecutor = new CustomToolExecutor(tools);
    } else {
      this.customToolExecutor.registerTools(tools);
    }
  }

  /**
   * Create a secure sandbox for JavaScript execution
   * - Uses Sandbox.SAFE_GLOBALS which excludes: Function, eval, require, process, etc.
   * - Only allows explicitly whitelisted prototype methods
   * - No access to filesystem, network, or system resources
   */
  private createSecureSandbox(): Sandbox {
    return createSecureSandbox();
  }

  getName(): string {
    return 'mcp';
  }

  getDescription(): string {
    return 'Call MCP tools directly using stdio, SSE, HTTP, or custom YAML-defined tools';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as McpCheckConfig;

    // Method is required
    if (!cfg.method || typeof cfg.method !== 'string') {
      logger.error('MCP check requires a method name');
      return false;
    }

    const transport = cfg.transport || 'stdio';

    // Validate transport-specific requirements
    if (transport === 'stdio') {
      if (!cfg.command || typeof cfg.command !== 'string') {
        logger.error('MCP stdio transport requires a command');
        return false;
      }

      // Basic command injection prevention - check for shell metacharacters
      // Allow common safe commands like 'npx', 'node', 'python', etc.
      if (/[;&|`$(){}[\]]/.test(cfg.command)) {
        logger.error('MCP stdio command contains potentially unsafe characters');
        return false;
      }
    } else if (transport === 'sse' || transport === 'http') {
      if (!cfg.url || typeof cfg.url !== 'string') {
        logger.error(`MCP ${transport} transport requires a URL`);
        return false;
      }

      // Validate URL format
      try {
        const parsedUrl = new URL(cfg.url);
        // Only allow http and https protocols
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          logger.error(
            `Invalid URL protocol for MCP ${transport} transport: ${parsedUrl.protocol}. Only http: and https: are allowed.`
          );
          return false;
        }
      } catch {
        logger.error(`Invalid URL format for MCP ${transport} transport: ${cfg.url}`);
        return false;
      }
    } else if (transport === 'custom') {
      // For custom transport, validation is delegated to CustomToolExecutor
      // The tool must exist in the configuration's tools section
      // This will be validated at execution time when the tool is looked up
      logger.debug(`MCP custom transport will validate tool '${cfg.method}' at execution time`);
    } else {
      logger.error(
        `Invalid MCP transport: ${transport}. Must be 'stdio', 'sse', 'http', or 'custom'`
      );
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    sessionInfo?: any
  ): Promise<ReviewSummary> {
    const cfg = config as McpCheckConfig;

    try {
      // Prepare template context
      const templateContext = {
        pr: {
          number: prInfo.number,
          title: prInfo.title,
          author: prInfo.author,
          branch: prInfo.head,
          base: prInfo.base,
        },
        files: prInfo.files,
        fileCount: prInfo.files.length,
        outputs: this.buildOutputContext(dependencyResults),
        args: sessionInfo?.args || {},
        env: this.getSafeEnvironmentVariables(),
      };

      // Render method arguments if needed
      let methodArgs = cfg.methodArgs || {};
      if (cfg.argsTransform) {
        const rendered = await this.liquid.parseAndRender(cfg.argsTransform, templateContext);
        try {
          methodArgs = JSON.parse(rendered);
        } catch (error) {
          logger.error(`Failed to parse argsTransform as JSON: ${error}`);
          return {
            issues: [
              {
                file: 'mcp',
                line: 0,
                ruleId: 'mcp/args_transform_error',
                message: `Failed to parse argsTransform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Create MCP client and execute method
      const result = await this.executeMcpMethod(cfg, methodArgs, prInfo, dependencyResults);

      // Apply transforms if specified
      let finalOutput = result;

      // Apply Liquid transform
      if (cfg.transform) {
        try {
          const transformContext = {
            ...templateContext,
            output: result,
          };
          const rendered = await this.liquid.parseAndRender(cfg.transform, transformContext);
          try {
            finalOutput = JSON.parse(rendered.trim());
          } catch {
            finalOutput = rendered.trim();
          }
        } catch (error) {
          logger.error(`Failed to apply Liquid transform: ${error}`);
          return {
            issues: [
              {
                file: 'mcp',
                line: 0,
                ruleId: 'mcp/transform_error',
                message: `Failed to apply transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Apply JavaScript transform using secure sandbox
      if (cfg.transform_js) {
        try {
          this.sandbox = this.createSecureSandbox();

          // Build scope with all context variables
          const scope = {
            output: finalOutput,
            pr: templateContext.pr,
            files: templateContext.files,
            outputs: templateContext.outputs,
            env: templateContext.env,
          };

          // Compile and execute the transform in sandboxed environment
          finalOutput = compileAndRun<unknown>(
            this.sandbox,
            `return (${cfg.transform_js});`,
            scope,
            { injectLog: true, wrapFunction: false, logPrefix: '[mcp:transform_js]' }
          );
        } catch (error) {
          logger.error(`Failed to apply JavaScript transform: ${error}`);
          return {
            issues: [
              {
                file: 'mcp',
                line: 0,
                ruleId: 'mcp/transform_js_error',
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Extract issues from output
      const extracted = this.extractIssuesFromOutput(finalOutput);
      if (extracted) {
        return {
          issues: extracted.issues,
          ...(extracted.remainingOutput ? { output: extracted.remainingOutput } : {}),
        } as ReviewSummary;
      }

      // Return output directly
      return {
        issues: [],
        ...(finalOutput ? { output: finalOutput } : {}),
      } as ReviewSummary;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`MCP check failed: ${errorMessage}`);

      return {
        issues: [
          {
            file: 'mcp',
            line: 0,
            ruleId: 'mcp/execution_error',
            message: `MCP check failed: ${errorMessage}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  /**
   * Execute an MCP method using the configured transport
   */
  private async executeMcpMethod(
    config: McpCheckConfig,
    methodArgs: Record<string, unknown>,
    prInfo?: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<unknown> {
    const transport = config.transport || 'stdio';
    const timeout = (config.timeout || 60) * 1000; // Convert to milliseconds

    if (transport === 'custom') {
      // Execute custom YAML-defined tool
      if (!this.customToolExecutor) {
        throw new Error(
          'No custom tools available. Define tools in the "tools" section of your configuration.'
        );
      }

      const tool = this.customToolExecutor.getTool(config.method);
      if (!tool) {
        throw new Error(
          `Custom tool not found: ${config.method}. Available tools: ${this.customToolExecutor
            .getTools()
            .map(t => t.name)
            .join(', ')}`
        );
      }

      // Build context for custom tool execution
      const context = {
        pr: prInfo
          ? {
              number: prInfo.number,
              title: prInfo.title,
              author: prInfo.author,
              branch: prInfo.head,
              base: prInfo.base,
            }
          : undefined,
        files: prInfo?.files,
        outputs: this.buildOutputContext(dependencyResults),
        env: this.getSafeEnvironmentVariables(),
      };

      return await this.customToolExecutor.execute(config.method, methodArgs, context);
    } else if (transport === 'stdio') {
      return await this.executeStdioMethod(config, methodArgs, timeout);
    } else if (transport === 'sse') {
      return await this.executeSseMethod(config, methodArgs, timeout);
    } else if (transport === 'http') {
      return await this.executeHttpMethod(config, methodArgs, timeout);
    } else {
      throw new Error(`Unsupported transport: ${transport}`);
    }
  }

  /**
   * Generic method to execute MCP method with any transport
   */
  private async executeWithTransport(
    transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport,
    config: McpCheckConfig,
    methodArgs: Record<string, unknown>,
    timeout: number,
    transportName: string
  ): Promise<unknown> {
    // Create client
    const client = new Client(
      {
        name: 'visor-mcp-client',
        version: '1.0.0',
      },
      {
        capabilities: {},
      }
    );

    try {
      // Connect with timeout
      let timeoutId: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Connection timeout')), timeout);
          }),
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }

      logger.debug(`Connected to MCP server via ${transportName}`);

      // Log session ID for HTTP transport
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
        logger.debug(`MCP Session ID: ${transport.sessionId}`);
      }

      // List available tools (for debugging)
      try {
        const toolsResult = await client.listTools();
        logger.debug(`Available MCP tools: ${JSON.stringify(toolsResult?.tools || [])}`);
      } catch (error) {
        logger.debug(`Could not list MCP tools: ${error}`);
      }

      // Call the tool with timeout
      let callTimeoutId: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          client.callTool({
            name: config.method,
            arguments: methodArgs,
          }),
          new Promise((_, reject) => {
            callTimeoutId = setTimeout(() => reject(new Error('Request timeout')), timeout);
          }),
        ]);

        logger.debug(`MCP method result: ${JSON.stringify(result)}`);
        return result;
      } finally {
        if (callTimeoutId) {
          clearTimeout(callTimeoutId);
        }
      }
    } finally {
      try {
        await client.close();
      } catch (error) {
        logger.debug(`Error closing MCP client: ${error}`);
      }
    }
  }

  /**
   * Execute MCP method using stdio transport
   */
  private async executeStdioMethod(
    config: McpCheckConfig,
    methodArgs: Record<string, unknown>,
    timeout: number
  ): Promise<unknown> {
    const transport = new StdioClientTransport({
      command: config.command!,
      args: config.command_args as string[] | undefined,
      env: config.env,
      cwd: config.workingDirectory,
    });

    return this.executeWithTransport(
      transport,
      config,
      methodArgs,
      timeout,
      `stdio: ${config.command}`
    );
  }

  /**
   * Execute MCP method using SSE transport
   */
  private async executeSseMethod(
    config: McpCheckConfig,
    methodArgs: Record<string, unknown>,
    timeout: number
  ): Promise<unknown> {
    const requestInit: RequestInit = {};
    if (config.headers) {
      requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
    }

    const transport = new SSEClientTransport(new URL(config.url!), {
      requestInit,
    });

    return this.executeWithTransport(transport, config, methodArgs, timeout, `SSE: ${config.url}`);
  }

  /**
   * Execute MCP method using Streamable HTTP transport
   */
  private async executeHttpMethod(
    config: McpCheckConfig,
    methodArgs: Record<string, unknown>,
    timeout: number
  ): Promise<unknown> {
    const requestInit: RequestInit = {};
    if (config.headers) {
      requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit,
      sessionId: config.sessionId,
    });

    return this.executeWithTransport(
      transport,
      config,
      methodArgs,
      timeout,
      `Streamable HTTP: ${config.url}`
    );
  }

  /**
   * Build output context from dependency results
   */
  private buildOutputContext(
    dependencyResults?: Map<string, ReviewSummary>
  ): Record<string, unknown> {
    if (!dependencyResults) {
      return {};
    }

    const outputs: Record<string, unknown> = {};
    for (const [checkName, result] of dependencyResults) {
      const summary = result as ReviewSummary & { output?: unknown };
      outputs[checkName] = summary.output !== undefined ? summary.output : summary;
    }

    return outputs;
  }

  /**
   * Get safe environment variables
   */
  private getSafeEnvironmentVariables(): Record<string, string> {
    const safeVars: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const allowedPrefixes: string[] = []; // replaced by buildSandboxEnv

    const { buildSandboxEnv } = require('../utils/env-exposure');
    const merged = buildSandboxEnv(process.env);
    for (const [key, value] of Object.entries(merged)) {
      safeVars[key] = String(value);
    }
    safeVars['PWD'] = process.cwd();
    return safeVars;
  }

  /**
   * Extract issues from MCP output
   */
  private extractIssuesFromOutput(
    output: unknown
  ): { issues: ReviewIssue[]; remainingOutput: unknown } | null {
    if (output === null || output === undefined) {
      return null;
    }

    // If output is a string, try to parse as JSON
    if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        return this.extractIssuesFromOutput(parsed);
      } catch {
        return null;
      }
    }

    // If output is an array of issues
    if (Array.isArray(output)) {
      const issues = this.normalizeIssueArray(output);
      if (issues) {
        return { issues, remainingOutput: undefined };
      }
      return null;
    }

    // If output is an object with issues property
    if (typeof output === 'object') {
      const record = output as Record<string, unknown>;

      if (Array.isArray(record.issues)) {
        const issues = this.normalizeIssueArray(record.issues);
        if (!issues) {
          return null;
        }

        const remaining = { ...record };
        delete (remaining as { issues?: unknown }).issues;

        return {
          issues,
          remainingOutput: Object.keys(remaining).length > 0 ? remaining : undefined,
        };
      }

      // Check if output itself is a single issue
      const singleIssue = this.normalizeIssue(record);
      if (singleIssue) {
        return { issues: [singleIssue], remainingOutput: undefined };
      }
    }

    return null;
  }

  /**
   * Normalize an array of issues
   */
  private normalizeIssueArray(values: unknown[]): ReviewIssue[] | null {
    const normalized: ReviewIssue[] = [];

    for (const value of values) {
      const issue = this.normalizeIssue(value);
      if (!issue) {
        return null;
      }
      normalized.push(issue);
    }

    return normalized;
  }

  /**
   * Normalize a single issue
   */
  private normalizeIssue(raw: unknown): ReviewIssue | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const data = raw as Record<string, unknown>;

    const message = this.toTrimmedString(
      data.message || data.text || data.description || data.summary
    );
    if (!message) {
      return null;
    }

    const allowedSeverities = new Set(['info', 'warning', 'error', 'critical']);
    const severityRaw = this.toTrimmedString(data.severity || data.level || data.priority);
    let severity: ReviewIssue['severity'] = 'warning';
    if (severityRaw) {
      const lower = severityRaw.toLowerCase();
      if (allowedSeverities.has(lower)) {
        severity = lower as ReviewIssue['severity'];
      }
    }

    const allowedCategories = new Set([
      'security',
      'performance',
      'style',
      'logic',
      'documentation',
    ]);
    const categoryRaw = this.toTrimmedString(data.category || data.type || data.group);
    let category: ReviewIssue['category'] = 'logic';
    if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
      category = categoryRaw.toLowerCase() as ReviewIssue['category'];
    }

    const file = this.toTrimmedString(data.file || data.path || data.filename) || 'system';
    const line = this.toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
    const endLine = this.toNumber(data.endLine || data.end_line || data.stopLine);
    const suggestion = this.toTrimmedString(data.suggestion);
    const replacement = this.toTrimmedString(data.replacement);
    const ruleId = this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || 'mcp';

    return {
      file,
      line,
      endLine: endLine ?? undefined,
      ruleId,
      message,
      severity,
      category,
      suggestion: suggestion || undefined,
      replacement: replacement || undefined,
    };
  }

  private toTrimmedString(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (value !== null && value !== undefined && typeof value.toString === 'function') {
      const converted = String(value).trim();
      return converted.length > 0 ? converted : null;
    }
    return null;
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const num = Number(value);
    if (Number.isFinite(num)) {
      return Math.trunc(num);
    }
    return null;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'transport',
      'command',
      'command_args',
      'env',
      'workingDirectory',
      'url',
      'headers',
      'sessionId',
      'method',
      'methodArgs',
      'argsTransform',
      'transform',
      'transform_js',
      'timeout',
      'depends_on',
      'on',
      'if',
      'group',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // MCP SDK is now a required dependency, so always available
    return true;
  }

  getRequirements(): string[] {
    return ['MCP method name specified', 'Transport configuration (stdio: command, sse/http: url)'];
  }
}
