import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { Liquid } from 'liquidjs';
import Sandbox from '@nyariv/sandboxjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';

/**
 * Check provider that executes shell commands and captures their output
 * Supports JSON parsing and integration with forEach functionality
 */
export class CommandCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox: Sandbox;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
    this.sandbox = this.createSecureSandbox();
  }

  private createSecureSandbox(): Sandbox {
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      console: console,
      JSON: JSON,
    };

    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
    return new Sandbox({ globals, prototypeWhitelist });
  }

  getName(): string {
    return 'command';
  }

  getDescription(): string {
    return 'Execute shell commands and capture output for processing';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Must have exec specified
    if (!cfg.exec || typeof cfg.exec !== 'string') {
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    const command = config.exec as string;
    const transform = config.transform as string | undefined;
    const transformJs = config.transform_js as string | undefined;

    // Prepare template context for Liquid rendering
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
      env: this.getSafeEnvironmentVariables(),
    };

    logger.debug(
      `🔧 Debug: Template outputs keys: ${Object.keys(templateContext.outputs || {}).join(', ')}`
    );

    try {
      // Render the command with Liquid templates if needed
      let renderedCommand = command;
      if (command.includes('{{') || command.includes('{%')) {
        renderedCommand = await this.renderCommandTemplate(command, templateContext);
      }

      logger.debug(`🔧 Debug: Rendered command: ${renderedCommand}`);

      // Prepare environment variables - convert all to strings
      const scriptEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          scriptEnv[key] = value;
        }
      }
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          if (value !== undefined && value !== null) {
            scriptEnv[key] = String(value);
          }
        }
      }

      // Execute the script using dynamic import to avoid Jest issues
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Get timeout from config (in seconds) or use default (60 seconds)
      const timeoutSeconds = (config.timeout as number) || 60;
      const timeoutMs = timeoutSeconds * 1000;

      const { stdout, stderr } = await execAsync(renderedCommand, {
        env: scriptEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      if (stderr) {
        logger.debug(`Command stderr: ${stderr}`);
      }

      // Keep raw output for transforms
      const rawOutput = stdout.trim();

      // Try to parse output as JSON for default behavior
      let output: unknown = rawOutput;
      try {
        // Attempt to parse as JSON
        const parsed = JSON.parse(rawOutput);
        output = parsed;
      } catch {
        // If not JSON, keep as string
        output = rawOutput;
      }

      // Apply transform if specified (Liquid or JavaScript)
      let finalOutput = output;

      // First apply Liquid transform if present
      if (transform) {
        try {
          const transformContext = {
            ...templateContext,
            output: output, // Use parsed output for Liquid (object if JSON, string otherwise)
          };
          const rendered = await this.liquid.parseAndRender(transform, transformContext);

          // Try to parse the transformed result as JSON
          try {
            finalOutput = JSON.parse(rendered.trim());
            logger.verbose(`✓ Applied Liquid transform successfully (parsed as JSON)`);
          } catch {
            finalOutput = rendered.trim();
            logger.verbose(`✓ Applied Liquid transform successfully (string output)`);
          }
        } catch (error) {
          logger.error(`✗ Failed to apply Liquid transform: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return {
            issues: [
              {
                file: 'command',
                line: 0,
                ruleId: 'command/transform_error',
                message: `Failed to apply Liquid transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Then apply JavaScript transform if present
      if (transformJs) {
        try {
          // For transform_js, provide a JSON-smart wrapper that:
          //  - behaves like a string when coerced (so JSON.parse(output) still works)
          //  - exposes parsed JSON properties if stdout is valid JSON (so output.key works)
          const jsContext = {
            output: this.makeJsonSmart(rawOutput),
            pr: templateContext.pr,
            files: templateContext.files,
            outputs: this.makeOutputsJsonSmart(templateContext.outputs),
            env: templateContext.env,
          };

          // Compile and execute the JavaScript expression
          // Use direct property access instead of destructuring to avoid syntax issues
          const trimmedTransform = transformJs.trim();
          let transformExpression: string;

          if (/return\s+/.test(trimmedTransform)) {
            transformExpression = `(() => {\n${trimmedTransform}\n})()`;
          } else {
            const lines = trimmedTransform.split('\n');
            if (lines.length > 1) {
              const lastLine = lines[lines.length - 1].trim();
              const remaining = lines.slice(0, -1).join('\n');
              if (lastLine && !lastLine.includes('}') && !lastLine.includes('{')) {
                const returnTarget = lastLine.replace(/;$/, '');
                transformExpression = `(() => {\n${remaining}\nreturn ${returnTarget};\n})()`;
              } else {
                transformExpression = `(${trimmedTransform})`;
              }
            } else {
              transformExpression = `(${trimmedTransform})`;
            }
          }

          const code = `
            const output = scope.output;
            const pr = scope.pr;
            const files = scope.files;
            const outputs = scope.outputs;
            const env = scope.env;
            const log = (...args) => {
              console.log('🔍 Debug:', ...args);
            };
            return ${transformExpression};
          `;

          try {
            logger.debug(`🔧 Debug: JavaScript transform code: ${code}`);
            logger.debug(
              `🔧 Debug: JavaScript context: ${JSON.stringify(jsContext).slice(0, 200)}`
            );
          } catch {
            // Ignore logging errors
          }

          const exec = this.sandbox.compile(code);

          finalOutput = exec({ scope: jsContext }).run();

          logger.verbose(`✓ Applied JavaScript transform successfully`);
          try {
            const preview = JSON.stringify(finalOutput);
            logger.debug(
              `🔧 Debug: transform_js result: ${typeof preview === 'string' ? preview.slice(0, 200) : String(preview).slice(0, 200)}`
            );
          } catch {
            try {
              const preview = String(finalOutput);
              logger.debug(`🔧 Debug: transform_js result: ${preview.slice(0, 200)}`);
            } catch {
              // Ignore logging errors
            }
          }
        } catch (error) {
          logger.error(`✗ Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return {
            issues: [
              {
                file: 'command',
                line: 0,
                ruleId: 'command/transform_js_error',
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Extract structured issues when the command returns them (skip for forEach parents)
      let issues: ReviewIssue[] = [];
      let outputForDependents: unknown = finalOutput;
      let content: string | undefined;
      let extracted: { issues: ReviewIssue[]; remainingOutput: unknown } | null = null;

      const trimmedRawOutput = typeof rawOutput === 'string' ? rawOutput.trim() : undefined;

      const commandConfig = config as CheckProviderConfig & { forEach?: boolean };
      const isForEachParent = commandConfig.forEach === true;

      if (!isForEachParent) {
        extracted = this.extractIssuesFromOutput(finalOutput);
        if (!extracted && typeof finalOutput === 'string') {
          // Attempt to parse string output as JSON and extract issues again
          try {
            const parsed = JSON.parse(finalOutput);
            extracted = this.extractIssuesFromOutput(parsed);
            if (extracted) {
              issues = extracted.issues;
              outputForDependents = extracted.remainingOutput;
            }
          } catch {
            // Ignore JSON parse errors – leave output as-is
          }
        } else if (extracted) {
          issues = extracted.issues;
          outputForDependents = extracted.remainingOutput;
        }

        if (!issues.length && this.shouldTreatAsTextOutput(trimmedRawOutput)) {
          content = trimmedRawOutput;
        } else if (issues.length && typeof extracted?.remainingOutput === 'string') {
          const trimmed = extracted.remainingOutput.trim();
          if (trimmed) {
            content = trimmed;
          }
        }
      }

      if (!content && this.shouldTreatAsTextOutput(trimmedRawOutput) && !isForEachParent) {
        content = trimmedRawOutput;
      }

      // Return the output and issues as part of the review summary so dependent checks can use them
      const result = {
        issues,
        output: outputForDependents,
        ...(content ? { content } : {}),
      } as ReviewSummary;

      if (transformJs) {
        try {
          const outputValue = (result as ReviewSummary & { output?: unknown }).output;
          const stringified = JSON.stringify(outputValue);
          logger.debug(
            `🔧 Debug: Command provider returning output: ${stringified ? stringified.slice(0, 200) : '(empty)'}`
          );
        } catch {
          // Ignore logging errors
        }
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        issues: [
          {
            file: 'command',
            line: 0,
            ruleId: 'command/execution_error',
            message: `Command execution failed: ${errorMessage}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  private buildOutputContext(
    dependencyResults?: Map<string, ReviewSummary>
  ): Record<string, unknown> {
    if (!dependencyResults) {
      return {};
    }

    const outputs: Record<string, unknown> = {};
    for (const [checkName, result] of dependencyResults) {
      // If the result has a direct output field, use it directly
      // Otherwise, expose the entire result as-is
      const summary = result as ReviewSummary & { output?: unknown };
      const value = summary.output !== undefined ? summary.output : summary;
      outputs[checkName] = this.makeJsonSmart(value);
    }
    return outputs;
  }

  /**
   * Wrap a value with JSON-smart behavior:
   *  - If it's a JSON string, expose parsed properties via Proxy (e.g., value.key)
   *  - When coerced to string (toString/valueOf/Symbol.toPrimitive), return the original raw string
   *  - If parsing fails or value is not a string, return the value unchanged
   */
  private makeJsonSmart<T = unknown>(value: T): T | any {
    if (typeof value !== 'string') {
      return value;
    }

    const raw = value as unknown as string;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON, return original string
      return raw;
    }

    // Use a boxed string so string methods still work via Proxy fallback
    const boxed = new String(raw);
    const handler: ProxyHandler<any> = {
      get(target, prop, receiver) {
        if (prop === 'toString' || prop === 'valueOf') {
          return () => raw;
        }
        if (prop === Symbol.toPrimitive) {
          return () => raw;
        }
        if (parsed != null && (typeof parsed === 'object' || Array.isArray(parsed))) {
          if (prop in parsed) {
            return (parsed as any)[prop as any];
          }
        }
        return Reflect.get(target, prop, receiver);
      },
      has(_target, prop) {
        if (parsed != null && (typeof parsed === 'object' || Array.isArray(parsed))) {
          if (prop in parsed) return true;
        }
        return false;
      },
      ownKeys(_target) {
        if (parsed != null && (typeof parsed === 'object' || Array.isArray(parsed))) {
          try {
            return Reflect.ownKeys(parsed);
          } catch {
            return [];
          }
        }
        return [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (parsed != null && (typeof parsed === 'object' || Array.isArray(parsed))) {
          const descriptor = Object.getOwnPropertyDescriptor(parsed, prop as any);
          if (descriptor) return descriptor;
        }
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: undefined,
        };
      },
    };
    return new Proxy(boxed, handler);
  }

  /**
   * Recursively apply JSON-smart wrapper to outputs object values
   */
  private makeOutputsJsonSmart(outputs: Record<string, unknown>): Record<string, unknown> {
    const wrapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(outputs || {})) {
      wrapped[k] = this.makeJsonSmart(v);
    }
    return wrapped;
  }

  private getSafeEnvironmentVariables(): Record<string, string> {
    const safeVars: Record<string, string> = {};
    const allowedPrefixes = ['CI_', 'GITHUB_', 'RUNNER_', 'NODE_', 'npm_', 'PATH', 'HOME', 'USER'];

    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && allowedPrefixes.some(prefix => key.startsWith(prefix))) {
        safeVars[key] = value;
      }
    }

    // Add current working directory
    safeVars['PWD'] = process.cwd();

    return safeVars;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'exec',
      'transform',
      'transform_js',
      'env',
      'timeout',
      'depends_on',
      'on',
      'if',
      'group',
      'forEach',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Command provider is always available as long as we can execute commands
    return true;
  }

  getRequirements(): string[] {
    return [
      'Valid shell command to execute',
      'Shell environment available',
      'Optional: Transform template for processing output',
    ];
  }

  private extractIssuesFromOutput(
    output: unknown
  ): { issues: ReviewIssue[]; remainingOutput: unknown } | null {
    if (output === null || output === undefined) {
      return null;
    }

    // If output is already a string, do not treat it as issues here (caller may try parsing JSON)
    if (typeof output === 'string') {
      return null;
    }

    if (Array.isArray(output)) {
      const issues = this.normalizeIssueArray(output);
      if (issues) {
        return { issues, remainingOutput: undefined };
      }
      return null;
    }

    if (typeof output === 'object') {
      const record = output as Record<string, unknown>;

      if (Array.isArray(record.issues)) {
        const issues = this.normalizeIssueArray(record.issues);
        if (!issues) {
          return null;
        }

        const remaining = { ...record };
        delete (remaining as { issues?: unknown }).issues;

        const remainingKeys = Object.keys(remaining);
        const remainingOutput = remainingKeys.length > 0 ? remaining : undefined;

        return {
          issues,
          remainingOutput,
        };
      }

      const singleIssue = this.normalizeIssue(record);
      if (singleIssue) {
        return { issues: [singleIssue], remainingOutput: undefined };
      }
    }

    return null;
  }

  private shouldTreatAsTextOutput(value?: string): value is string {
    if (!value) {
      return false;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }

    // Heuristic: consider it JSON-like if it starts with { or [ and ends with } or ]
    const startsJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));

    return !startsJson;
  }

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
      } else if (['fatal', 'high'].includes(lower)) {
        severity = 'error';
      } else if (['medium', 'moderate'].includes(lower)) {
        severity = 'warning';
      } else if (['low', 'minor'].includes(lower)) {
        severity = 'info';
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
      this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || 'command';

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

  private async renderCommandTemplate(
    template: string,
    context: {
      pr: Record<string, unknown>;
      files: unknown[];
      outputs: Record<string, unknown>;
      env: Record<string, string>;
    }
  ): Promise<string> {
    try {
      return await this.liquid.parseAndRender(template, context);
    } catch (error) {
      logger.debug(`🔧 Debug: Liquid rendering failed, falling back to JS evaluation: ${error}`);
      return this.renderWithJsExpressions(template, context);
    }
  }

  private renderWithJsExpressions(
    template: string,
    context: {
      pr: Record<string, unknown>;
      files: unknown[];
      outputs: Record<string, unknown>;
      env: Record<string, string>;
    }
  ): string {
    const scope = {
      pr: context.pr,
      files: context.files,
      outputs: context.outputs,
      env: context.env,
    };

    const expressionRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;

    return template.replace(expressionRegex, (_match, expr) => {
      const expression = String(expr).trim();
      if (!expression) {
        return '';
      }

      try {
        const evalCode = `
          const pr = scope.pr;
          const files = scope.files;
          const outputs = scope.outputs;
          const env = scope.env;
          return (${expression});
        `;

        const evaluator = this.sandbox.compile(evalCode);
        const result = evaluator({ scope }).run();
        return result === undefined || result === null ? '' : String(result);
      } catch (evaluationError) {
        logger.debug(`🔧 Debug: Failed to evaluate expression: ${expression} - ${evaluationError}`);
        return '';
      }
    });
  }
}
