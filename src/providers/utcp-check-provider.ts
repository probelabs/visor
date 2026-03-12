import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { logger } from '../logger';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { EnvironmentResolver } from '../utils/env-resolver';
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

        // Call tool with timeout
        const result = await Promise.race([
          client.callTool(toolName, methodArgs as Record<string, any>),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`UTCP tool call timed out after ${cfg.timeout || 60}s`)),
              timeout
            )
          ),
        ]);

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
            return {
              issues: [
                {
                  file: 'utcp',
                  line: 0,
                  ruleId: 'utcp/transform_error',
                  message: `Failed to apply transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                  severity: 'error',
                  category: 'logic',
                },
              ],
            };
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
            return {
              issues: [
                {
                  file: 'utcp',
                  line: 0,
                  ruleId: 'utcp/transform_js_error',
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
   * Resolve manual config to a UTCP call template object
   */
  private async resolveManualCallTemplate(
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
        name: this.deriveManualName(manual),
        call_template_type: 'http',
        url: manual,
        http_method: 'GET',
      };
    }

    // File-based discovery
    const resolvedPath = path.resolve(manual);

    // First, read and check if the file is already a call template
    const content = fs.readFileSync(resolvedPath, 'utf-8');
    const parsed = JSON.parse(content);

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
   * Derive a manual name from a URL
   */
  private deriveManualName(url: string): string {
    try {
      const parsed = new URL(url);
      // Use hostname with dots replaced by underscores
      return parsed.hostname.replace(/\./g, '_').replace(/-/g, '_');
    } catch {
      return 'utcp_manual';
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

  /**
   * Extract issues from UTCP output
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
    const ruleId =
      this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || 'utcp';

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
