import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { logger } from '../logger';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { EnvironmentResolver } from '../utils/env-resolver';
import { extractIssuesFromOutput } from '../utils/issue-normalizer';
import * as fs from 'fs';
import * as path from 'path';

/**
 * UTCP Check Provider Configuration
 */
export interface UtcpCheckConfig extends CheckProviderConfig {
  /** UTCP manual source: URL string, file path string, or inline call template object */
  manual: string | Record<string, unknown>;
  /** Tool method name to call (format: manual_name.tool_name or just tool_name) */
  method: string;
  /** Arguments to pass to the UTCP tool (supports Liquid templates) */
  methodArgs?: Record<string, unknown>;
  /** Transform template for method arguments (Liquid) - overrides methodArgs */
  argsTransform?: string;
  /** UTCP variables for manual authentication/configuration */
  variables?: Record<string, string>;
  /** UTCP plugins to load (default: ['http']) */
  plugins?: string[];
  /** Transform template for output (Liquid) */
  transform?: string;
  /** Transform using JavaScript expressions */
  transform_js?: string;
  /** Timeout in seconds (default: 60) */
  timeout?: number;
}

/**
 * Check provider that calls UTCP (Universal Tool Calling Protocol) tools directly.
 * UTCP is a client-side protocol where tools publish JSON "manuals" describing
 * how to call them via their native protocols (HTTP, CLI, SSE, etc.).
 *
 * Supports manual discovery from:
 * - HTTP/HTTPS URLs (GET endpoint returning UTCP manual)
 * - Local JSON files
 * - Inline call template objects
 */
export class UtcpCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox?: Sandbox;
  private sdkAvailable: boolean | null = null;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
  }

  getName(): string {
    return 'utcp';
  }

  getDescription(): string {
    return 'Call UTCP tools directly using their native protocols (HTTP, CLI, SSE)';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as UtcpCheckConfig;

    // Type must be utcp
    if (cfg.type !== 'utcp') {
      return false;
    }

    // Manual is required
    if (!cfg.manual) {
      logger.error('UTCP check requires a manual (URL, file path, or inline call template)');
      return false;
    }

    // Method is required
    if (!cfg.method || typeof cfg.method !== 'string') {
      logger.error('UTCP check requires a method name');
      return false;
    }

    // Validate manual format
    if (typeof cfg.manual === 'string') {
      // URL validation
      if (cfg.manual.startsWith('http://') || cfg.manual.startsWith('https://')) {
        try {
          const parsedUrl = new URL(cfg.manual);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            logger.error(`Invalid URL protocol for UTCP manual: ${parsedUrl.protocol}`);
            return false;
          }
        } catch {
          logger.error(`Invalid URL format for UTCP manual: ${cfg.manual}`);
          return false;
        }
      }
      // File paths are validated at execution time
    } else if (typeof cfg.manual === 'object') {
      // Inline call template must have call_template_type
      if (!cfg.manual.call_template_type) {
        logger.error('Inline UTCP manual must have call_template_type');
        return false;
      }
    } else {
      logger.error('UTCP manual must be a URL string, file path, or inline call template object');
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
    const cfg = config as UtcpCheckConfig;

    // Test hook: mock output for this step
    try {
      const stepName = (config as any).checkName || 'unknown';
      const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
      if (mock !== undefined) {
        const ms = mock as any;
        const issuesArr = Array.isArray(ms?.issues) ? (ms.issues as any[]) : [];
        const out = ms && typeof ms === 'object' && 'output' in ms ? ms.output : ms;
        return {
          issues: issuesArr,
          ...(out !== undefined ? { output: out } : {}),
        } as ReviewSummary;
      }
    } catch {}

    try {
      // Build template context
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
        inputs: (config as any).workflowInputs || sessionInfo?.workflowInputs || {},
      };

      // Render method arguments
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
                file: 'utcp',
                line: 0,
                ruleId: 'utcp/args_transform_error',
                message: `Failed to parse argsTransform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      } else if (methodArgs && typeof methodArgs === 'object') {
        // Recursively render Liquid templates in methodArgs
        const renderValue = async (val: unknown): Promise<unknown> => {
          if (typeof val === 'string' && (val.includes('{{') || val.includes('{%'))) {
            return await this.liquid.parseAndRender(val, templateContext);
          } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const rendered: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(val)) {
              rendered[k] = await renderValue(v);
            }
            return rendered;
          } else if (Array.isArray(val)) {
            return Promise.all(val.map(item => renderValue(item)));
          }
          return val;
        };
        methodArgs = (await renderValue(methodArgs)) as Record<string, unknown>;
      }

      // Resolve manual to a call template
      const callTemplate = await this.resolveManualCallTemplate(cfg.manual);

      // Resolve variables through environment resolver
      const resolvedVariables: Record<string, string> = {};
      if (cfg.variables) {
        for (const [key, value] of Object.entries(cfg.variables)) {
          resolvedVariables[key] = String(EnvironmentResolver.resolveValue(value));
        }
      }

      // Dynamic import UTCP SDK
      const { UtcpClient } = await import('@utcp/sdk');

      // Load plugins
      const plugins = cfg.plugins || ['http'];
      for (const plugin of plugins) {
        try {
          await import(`@utcp/${plugin}`);
        } catch (err) {
          logger.debug(`UTCP plugin @utcp/${plugin} not available: ${err}`);
        }
      }

      // Create UTCP client
      const timeout = (cfg.timeout || 60) * 1000;
      const client = await UtcpClient.create(process.cwd(), {
        manual_call_templates: [callTemplate],
        variables: resolvedVariables,
      } as any);

      try {
        // Resolve tool name - try exact match first, then suffix match
        let toolName = cfg.method;
        try {
          const tools = await client.getTools();
          const toolNames = tools.map((t: any) => t.name as string);
          logger.debug(`UTCP tools available: ${JSON.stringify(toolNames)}`);

          if (!toolNames.includes(toolName)) {
            // Try suffix match: user may specify "get_ip" but tool is "manual_name.get_ip"
            const suffixMatch = toolNames.find((name: string) => name.endsWith(`.${toolName}`));
            if (suffixMatch) {
              logger.debug(
                `UTCP method '${toolName}' resolved to '${suffixMatch}' via suffix match`
              );
              toolName = suffixMatch;
            }
          }
        } catch (err) {
          logger.debug(`Failed to list UTCP tools for name resolution: ${err}`);
        }

        // Call tool with timeout (clear timer on success to avoid resource leak)
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          client.callTool(toolName, methodArgs as Record<string, any>),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`UTCP tool call timed out after ${cfg.timeout || 60}s`)),
              timeout
            );
          }),
        ]).finally(() => clearTimeout(timer));

        // Apply transforms
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
            // Throw to let the outer finally close the client before returning
            throw new Error(
              `Failed to apply transform: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Apply JavaScript transform
        if (cfg.transform_js) {
          try {
            this.sandbox = createSecureSandbox();
            const scope = {
              output: finalOutput,
              pr: templateContext.pr,
              files: templateContext.files,
              outputs: templateContext.outputs,
              env: templateContext.env,
            };
            finalOutput = compileAndRun<unknown>(
              this.sandbox,
              `return (${cfg.transform_js});`,
              scope,
              { injectLog: true, wrapFunction: false, logPrefix: '[utcp:transform_js]' }
            );
          } catch (error) {
            logger.error(`Failed to apply JavaScript transform: ${error}`);
            // Throw to let the outer finally close the client before returning
            throw new Error(
              `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Extract issues from output
        const extracted = extractIssuesFromOutput(finalOutput, 'utcp');
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
      } finally {
        try {
          await client.close();
        } catch (err) {
          logger.debug(`Failed to close UTCP client: ${err}`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const isTimeout = this.isTimeoutError(error);
      const severity: ReviewIssue['severity'] = isTimeout ? 'warning' : 'error';
      const ruleId = isTimeout ? 'utcp/timeout' : 'utcp/execution_error';

      if (isTimeout) {
        logger.warn(`UTCP check timed out: ${errorMessage}`);
      } else {
        logger.error(`UTCP check failed: ${errorMessage}`);
      }

      return {
        issues: [
          {
            file: 'utcp',
            line: 0,
            ruleId,
            message: isTimeout
              ? `UTCP check timed out: ${errorMessage}`
              : `UTCP check failed: ${errorMessage}`,
            severity,
            category: 'logic',
          },
        ],
      };
    }
  }

  /**
   * Resolve manual config to a UTCP call template object (instance method, delegates to static)
   */
  private async resolveManualCallTemplate(
    manual: string | Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return UtcpCheckProvider.resolveManualCallTemplate(manual);
  }

  /**
   * Resolve manual config to a UTCP call template object.
   * Shared utility used by both the standalone UTCP provider and the AI check provider's UTCP-to-MCP bridge.
   */
  static async resolveManualCallTemplate(
    manual: string | Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (typeof manual === 'object') {
      if (!manual.call_template_type) {
        throw new Error('Inline manual must have call_template_type');
      }
      // Ensure it has a name
      if (!manual.name) {
        manual.name = 'inline';
      }
      return manual;
    }

    // URL-based discovery
    if (manual.startsWith('http://') || manual.startsWith('https://')) {
      return {
        name: UtcpCheckProvider.deriveManualName(manual),
        call_template_type: 'http',
        url: manual,
        http_method: 'GET',
      };
    }

    // File-based discovery

    // Security: reject null bytes that could bypass path validation
    if (manual.includes('\0')) {
      throw new Error('Invalid UTCP manual path: null bytes are not allowed');
    }

    const resolvedPath = path.resolve(manual);

    // Security: ensure resolved path stays within cwd (prevent path traversal)
    const cwd = path.resolve(process.cwd());
    const normalizedResolved = path.normalize(resolvedPath);
    const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
    if (normalizedResolved !== cwd && !normalizedResolved.startsWith(cwdPrefix)) {
      throw new Error(
        `Path traversal detected: "${manual}" resolves outside the project directory. ` +
          `UTCP manual paths must be within the project directory.`
      );
    }

    // Security: resolve symlinks and re-validate to prevent symlink attacks
    if (fs.existsSync(resolvedPath)) {
      const realPath = fs.realpathSync(resolvedPath);
      if (realPath !== cwd && !realPath.startsWith(cwdPrefix)) {
        throw new Error(
          `Symlink traversal detected: "${manual}" points outside the project directory via symlink.`
        );
      }
    }

    // Validate file exists and is readable
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`UTCP manual file not found: ${resolvedPath}`);
    }

    // Read and parse the file
    let content: string;
    try {
      content = fs.readFileSync(resolvedPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read UTCP manual file: ${resolvedPath}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(
        `Failed to parse UTCP manual file as JSON: ${resolvedPath}: ${err instanceof Error ? err.message : 'Unknown error'}`
      );
    }

    if (parsed.call_template_type) {
      // File contains a call template directly - use as-is
      if (!parsed.name) {
        parsed.name = path.basename(resolvedPath, path.extname(resolvedPath));
      }
      return parsed;
    }

    // File contains a UTCP manual - use file call template to let SDK handle it
    // Load the file plugin for file-based manuals
    try {
      await import('@utcp/file');
    } catch {
      logger.debug('UTCP @utcp/file plugin not available, attempting direct parse');
    }

    return {
      name: parsed.name || path.basename(resolvedPath, path.extname(resolvedPath)),
      call_template_type: 'file',
      file_path: resolvedPath,
      allowed_communication_protocols: ['file', 'http', 'https'],
    };
  }

  /**
   * Derive a manual name from a URL (instance method, delegates to static)
   */
  private deriveManualName(url: string): string {
    return UtcpCheckProvider.deriveManualName(url);
  }

  /**
   * Derive a manual name from a URL.
   * Shared utility for UTCP manual name derivation.
   */
  static deriveManualName(url: string): string {
    try {
      const parsed = new URL(url);
      // Use hostname with dots replaced by underscores
      return parsed.hostname.replace(/\./g, '_').replace(/-/g, '_');
    } catch {
      return 'utcp_manual';
    }
  }

  /**
   * Call a UTCP tool directly. Shared by both the standalone provider and the MCP-bridge SSE server.
   * Handles SDK import, plugin loading, client creation, tool calling, and cleanup.
   */
  static async callTool(
    manual: string | Record<string, unknown>,
    toolName: string,
    args: Record<string, unknown>,
    options?: {
      variables?: Record<string, string>;
      plugins?: string[];
      timeoutMs?: number;
    }
  ): Promise<unknown> {
    const variables = options?.variables || {};
    const plugins = options?.plugins || ['http'];
    const timeoutMs = options?.timeoutMs || 60000;

    // Dynamic import UTCP SDK and plugins
    const { UtcpClient } = await import('@utcp/sdk');
    for (const plugin of plugins) {
      try {
        await import(`@utcp/${plugin}`);
      } catch {
        logger.debug(`UTCP plugin @utcp/${plugin} not available`);
      }
    }

    // Resolve manual to call template
    const callTemplate = await UtcpCheckProvider.resolveManualCallTemplate(manual);

    // Create client
    const client = await UtcpClient.create(process.cwd(), {
      manual_call_templates: [callTemplate],
      variables,
    } as any);

    try {
      // Call tool with timeout (clear timer on success to avoid resource leak)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        client.callTool(toolName, args as Record<string, any>),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`UTCP tool '${toolName}' timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]).finally(() => clearTimeout(timer));

      return result;
    } finally {
      try {
        if (typeof (client as any).close === 'function') {
          await (client as any).close();
        }
      } catch {}
    }
  }

  /**
   * Check if an error is a timeout error
   */
  private isTimeoutError(error: unknown): boolean {
    const err = error as { message?: unknown; code?: unknown; cause?: unknown };
    const message = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
    const code = typeof err?.code === 'string' ? err.code.toLowerCase() : '';
    return message.includes('timeout') || message.includes('timed out') || code.includes('timeout');
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
    const { buildSandboxEnv } = require('../utils/env-exposure');
    const merged = buildSandboxEnv(process.env);
    for (const [key, value] of Object.entries(merged)) {
      safeVars[key] = String(value);
    }
    safeVars['PWD'] = process.cwd();
    return safeVars;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'manual',
      'method',
      'methodArgs',
      'argsTransform',
      'variables',
      'plugins',
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
    if (this.sdkAvailable !== null) {
      return this.sdkAvailable;
    }
    try {
      await import('@utcp/sdk');
      this.sdkAvailable = true;
    } catch {
      this.sdkAvailable = false;
    }
    return this.sdkAvailable;
  }

  getRequirements(): string[] {
    return [
      '@utcp/sdk package installed',
      'UTCP manual source (URL, file path, or inline)',
      'Tool method name',
    ];
  }
}
