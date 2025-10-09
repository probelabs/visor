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
  private sandbox?: Sandbox;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
    // Lazily create sandbox only when transform_js is used
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
    try {
      logger.info(
        `  command provider: executing check=${String((config as any).checkName || config.type)} hasTransformJs=${Boolean(
          (config as any).transform_js
        )}`
      );
    } catch {}
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
      // no debug
      let output: unknown = rawOutput;
      try {
        // Attempt to parse as JSON
        const parsed = JSON.parse(rawOutput);
        output = parsed;
        logger.debug(`🔧 Debug: Parsed entire output as JSON successfully`);
      } catch {
        // Try to extract JSON from the end of output (for commands with debug logs)
        const extractedTail = this.extractJsonFromEnd(rawOutput);
        if (extractedTail) {
          try {
            output = JSON.parse(extractedTail);
          } catch {
            output = rawOutput;
          }
        } else {
          // Try to extract any balanced JSON substring anywhere
          const extractedAny = this.extractJsonAnywhere(rawOutput);
          if (extractedAny) {
            try {
              output = JSON.parse(extractedAny);
            } catch {
              output = rawOutput;
            }
          } else {
            // Last resort: detect common boolean flags like error:true or error=false for fail_if gating
            const m = /\berror\b\s*[:=]\s*(true|false)/i.exec(rawOutput);
            if (m) {
              output = { error: m[1].toLowerCase() === 'true' } as any;
            } else {
              output = rawOutput;
            }
          }
        }
      }

      // Log the parsed structure for debugging
      // no debug

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
          logger.error(
            `✗ Failed to apply Liquid transform: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
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
          // Evaluate transform_js as-is; if it's an expression, parentheses are fine; if it's an IIFE, run it.
          // Avoid wrapping to prevent double-IIFE swallowing returns.
          const transformExpression = `(${trimmedTransform})`;

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

          // no debug

          try {
            const fn = new Function(
              'scope',
              `"use strict"; const output=scope.output, pr=scope.pr, files=scope.files, outputs=scope.outputs, env=scope.env, log=(...a)=>console.log('🔍 Debug:',...a); return ${transformExpression};`
            );
            // Pass the scope object directly (not wrapped)
            finalOutput = fn(jsContext);
          } catch {
            if (!this.sandbox) {
              this.sandbox = this.createSecureSandbox();
            }
            const exec = this.sandbox.compile(code);
            finalOutput = exec({ scope: jsContext }).run();
          }

          logger.verbose(`✓ Applied JavaScript transform successfully`);
          try {
            // Coerce to plain object to materialize any proxy-like properties, but do not break arrays
            if (finalOutput && typeof finalOutput === 'object' && !Array.isArray(finalOutput)) {
              finalOutput = { ...(finalOutput as Record<string, unknown>) };
            }
          } catch {}
          // no debug
        } catch (error) {
          logger.error(
            `✗ Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
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
      // no debug
      let issues: ReviewIssue[] = [];
      let outputForDependents: unknown = finalOutput;
      let content: string | undefined;
      let extracted: { issues: ReviewIssue[]; remainingOutput: unknown } | null = null;

      const trimmedRawOutput = typeof rawOutput === 'string' ? rawOutput.trim() : undefined;

      const commandConfig = config as CheckProviderConfig & { forEach?: boolean };
      const isForEachParent = commandConfig.forEach === true;

      if (!isForEachParent) {
        extracted = this.extractIssuesFromOutput(finalOutput);
        // no debug
        if (!extracted && typeof finalOutput === 'string') {
          // Attempt to parse string output as JSON and extract issues again
          try {
            const parsed = JSON.parse(finalOutput);
            extracted = this.extractIssuesFromOutput(parsed);
            if (extracted) {
              issues = extracted.issues;
              outputForDependents = extracted.remainingOutput;
              // If remainingOutput carries a content field, pick it up
              if (
                typeof extracted.remainingOutput === 'object' &&
                extracted.remainingOutput !== null &&
                typeof (extracted.remainingOutput as any).content === 'string'
              ) {
                const c = String((extracted.remainingOutput as any).content).trim();
                if (c) content = c;
              }
            }
          } catch {
            // Try to salvage JSON from anywhere within the string (stripped logs/ansi)
            try {
              const any = this.extractJsonAnywhere(finalOutput);
              if (any) {
                const parsed = JSON.parse(any);
                extracted = this.extractIssuesFromOutput(parsed);
                if (extracted) {
                  issues = extracted.issues;
                  outputForDependents = extracted.remainingOutput;
                  if (
                    typeof extracted.remainingOutput === 'object' &&
                    extracted.remainingOutput !== null &&
                    typeof (extracted.remainingOutput as any).content === 'string'
                  ) {
                    const c = String((extracted.remainingOutput as any).content).trim();
                    if (c) content = c;
                  }
                }
              }
            } catch {
              // leave as-is
            }
          }
        } else if (extracted) {
          issues = extracted.issues;
          outputForDependents = extracted.remainingOutput;
          // Also propagate embedded content when remainingOutput is an object { content, ... }
          if (
            typeof extracted.remainingOutput === 'object' &&
            extracted.remainingOutput !== null &&
            typeof (extracted.remainingOutput as any).content === 'string'
          ) {
            const c = String((extracted.remainingOutput as any).content).trim();
            if (c) content = c;
          }
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

      // no debug

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Check if this is a timeout error
      let isTimeout = false;
      if (error && typeof error === 'object') {
        const execError = error as { killed?: boolean; signal?: string; code?: string | number };
        // Node's child_process sets killed=true and signal='SIGTERM' on timeout
        if (execError.killed && execError.signal === 'SIGTERM') {
          isTimeout = true;
        }
        // Some versions may also set code to 'ETIMEDOUT'
        if (execError.code === 'ETIMEDOUT') {
          isTimeout = true;
        }
      }

      // Extract stderr from the error if available (child_process errors include stdout/stderr)
      let stderrOutput = '';
      if (error && typeof error === 'object') {
        const execError = error as { stderr?: string; stdout?: string };
        if (execError.stderr) {
          stderrOutput = execError.stderr.trim();
        }
      }

      // Construct detailed error message
      let detailedMessage: string;
      let ruleId: string;

      if (isTimeout) {
        const timeoutSeconds = (config.timeout as number) || 60;
        detailedMessage = `Command execution timed out after ${timeoutSeconds} seconds`;
        if (stderrOutput) {
          detailedMessage += `\n\nStderr output:\n${stderrOutput}`;
        }
        ruleId = 'command/timeout';
      } else {
        detailedMessage = stderrOutput
          ? `Command execution failed: ${errorMessage}\n\nStderr output:\n${stderrOutput}`
          : `Command execution failed: ${errorMessage}`;
        ruleId = 'command/execution_error';
      }

      logger.error(`✗ ${detailedMessage}`);

      return {
        issues: [
          {
            file: 'command',
            line: 0,
            ruleId,
            message: detailedMessage,
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
   *  - Attempts to extract JSON from the end of the output if full parse fails
   */
  private makeJsonSmart<T = unknown>(value: T): T | any {
    if (typeof value !== 'string') {
      return value;
    }

    const raw = value as unknown as string;
    let parsed: any;

    // First try: parse the entire string as JSON
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Second try: extract JSON from the end of the output
      // Look for { or [ at the start of a line and take everything after it
      const jsonMatch = this.extractJsonFromEnd(raw);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch);
          logger.debug(
            `🔧 Debug: Extracted JSON from end of output (${jsonMatch.length} chars from ${raw.length} total)`
          );
        } catch {
          // Not valid JSON even after extraction, return original string
          return raw;
        }
      } else {
        // Not JSON, return original string
        return raw;
      }
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
   * Extract JSON from the end of a string that may contain logs/debug output
   * Looks for the last occurrence of { or [ and tries to parse from there
   */
  private extractJsonFromEnd(text: string): string | null {
    // Robust strategy: find the last closing brace/bracket, then walk backwards to the matching opener
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (lastBrace === -1) return null;
    // Scan backwards to find matching opener with a simple counter
    let open = 0;
    for (let i = lastBrace; i >= 0; i--) {
      const ch = text[i];
      if (ch === '}' || ch === ']') open++;
      else if (ch === '{' || ch === '[') open--;
      if (open === 0 && (ch === '{' || ch === '[')) {
        const candidate = text.slice(i, lastBrace + 1).trim();
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  // Extract any balanced JSON object/array substring from anywhere in the text
  private extractJsonAnywhere(text: string): string | null {
    const n = text.length;
    let best: string | null = null;
    for (let i = 0; i < n; i++) {
      const start = text[i];
      if (start !== '{' && start !== '[') continue;
      let open = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < n; j++) {
        const ch = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === '{' || ch === '[') open++;
        else if (ch === '}' || ch === ']') open--;
        if (open === 0 && (ch === '}' || ch === ']')) {
          const candidate = text.slice(i, j + 1).trim();
          try {
            JSON.parse(candidate);
            best = candidate; // keep the last valid one we find
          } catch {
            // Try a loose-to-strict conversion (quote keys and barewords)
            const strict = this.looseJsonToStrict(candidate);
            if (strict) {
              try {
                JSON.parse(strict);
                best = strict;
              } catch {}
            }
          }
          break;
        }
      }
    }
    return best;
  }

  // Best-effort conversion of object-literal-like strings to strict JSON
  private looseJsonToStrict(candidate: string): string | null {
    try {
      let s = candidate.trim();
      // Convert single quotes to double quotes conservatively
      s = s.replace(/'/g, '"');
      // Quote unquoted keys: {key: ...} or ,key: ...
      s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
      // Quote bareword values except true/false/null and numbers
      s = s.replace(/:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,}])/g, (m, word) => {
        const lw = String(word).toLowerCase();
        if (lw === 'true' || lw === 'false' || lw === 'null') return `:${lw}`;
        return `:"${word}"`;
      });
      return s;
    } catch {
      return null;
    }
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
    try {
      logger.info(
        `  extractIssuesFromOutput: typeof=${Array.isArray(output) ? 'array' : typeof output}`
      );
      if (typeof output === 'object' && output) {
        const rec = output as Record<string, unknown>;
        logger.info(
          `  extractIssuesFromOutput: keys=${Object.keys(rec).join(',')} issuesIsArray=${Array.isArray(
            (rec as any).issues
          )}`
        );
      }
    } catch {}
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
      // Keep it simple: render via Liquid only (no JS pre-pass)
      const rendered = await this.liquid.parseAndRender(template, context);
      return rendered;
    } catch (error) {
      logger.debug(`🔧 Debug: Liquid templating failed, returning original template: ${error}`);
      return template;
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
      if (!expression) return '';
      try {
        const evalCode = `
          const pr = scope.pr;
          const files = scope.files;
          const outputs = scope.outputs;
          const env = scope.env;
          return (${expression});
        `;
        if (!this.sandbox) this.sandbox = this.createSecureSandbox();
        const evaluator = this.sandbox.compile(evalCode);
        const result = evaluator({ scope }).run();
        return result === undefined || result === null ? '' : String(result);
      } catch {
        return '';
      }
    });
  }
}
