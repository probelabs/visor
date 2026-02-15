import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
// eslint-disable-next-line no-restricted-imports -- needed for Liquid type
import { Liquid } from 'liquidjs';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import { commandExecutor } from '../utils/command-executor';
import {
  createPermissionHelpers,
  detectLocalMode,
  resolveAssociationFromEvent,
} from '../utils/author-permissions';
import { trace, context as otContext } from '../telemetry/lazy-otel';
import {
  captureCheckInputContext,
  captureCheckOutput,
  captureTransformJS,
  sanitizeContextForTelemetry,
} from '../telemetry/state-capture';

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
    return createSecureSandbox();
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
    dependencyResults?: Map<string, ReviewSummary>,
    context?: import('./check-provider.interface').ExecutionContext
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
    const outputsObj = this.buildOutputContext(
      dependencyResults,
      config.__outputHistory as Map<string, unknown[]> | undefined
    );

    // Build outputs_raw from -raw keys in dependencyResults
    const outputsRaw: Record<string, unknown> = {};
    if (dependencyResults) {
      for (const [key, value] of dependencyResults.entries()) {
        if (typeof key !== 'string') continue;
        if (key.endsWith('-raw')) {
          const name = key.slice(0, -4);
          const summary = value as ReviewSummary & { output?: unknown };
          outputsRaw[name] = summary.output !== undefined ? summary.output : summary;
        }
      }
    }

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
      outputs: outputsObj,
      // Alias: outputs_history mirrors outputs.history for consistency
      outputs_history: (outputsObj as any).history || {},
      // Stage-scoped history slice based on baseline provided by runner
      outputs_history_stage: (() => {
        const stage: Record<string, unknown[]> = {};
        try {
          const base = (context as any)?.stageHistoryBase as Record<string, number> | undefined;
          const histMap = (config as any).__outputHistory as Map<string, unknown[]> | undefined;
          if (!base || !histMap) return stage;
          for (const [k, v] of histMap.entries()) {
            const start = base[k] || 0;
            const arr = Array.isArray(v) ? (v as unknown[]) : [];
            stage[k] = arr.slice(start);
          }
        } catch {}
        return stage;
      })(),
      // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
      outputs_raw: outputsRaw,
      // Workflow inputs (when executing within a workflow)
      // Check config first (set by projectWorkflowToGraph), then fall back to context
      inputs: (config as any).workflowInputs || context?.workflowInputs || {},
      // Custom arguments from on_init 'with' directive
      args: context?.args || {},
      env: this.getSafeEnvironmentVariables(),
    };

    logger.debug(
      `🔧 Debug: Template outputs keys: ${Object.keys(templateContext.outputs || {}).join(', ')}`
    );

    // Capture input context in active OTEL span
    try {
      const span = trace.getSpan(otContext.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
      // Ignore telemetry errors
    }
    // Fallback NDJSON for input context (non-OTEL environments)
    try {
      const checkId = (config as any).checkName || (config as any).id || 'unknown';
      // Sanitize context to avoid leaking API keys in traces
      const ctxJson = JSON.stringify(sanitizeContextForTelemetry(templateContext));
      const { emitNdjsonSpanWithEvents } = require('../telemetry/fallback-ndjson');
      // Emit both start and completion markers together for deterministic E2E assertions
      emitNdjsonSpanWithEvents(
        'visor.check',
        { 'visor.check.id': checkId, 'visor.check.input.context': ctxJson },
        [{ name: 'check.started' }, { name: 'check.completed' }]
      );
    } catch {}

    // Test hook: mock output for this step (short-circuit execution)
    try {
      const stepName = (config as any).checkName || 'unknown';
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(
          `[Command] Mock check: stepName=${stepName}, context=${!!context}, hooks=${!!context?.hooks}, mockForStep=${!!context?.hooks?.mockForStep}`
        );
      }
      const rawMock = context?.hooks?.mockForStep?.(String(stepName));
      if (process.env.VISOR_DEBUG === 'true') {
        logger.debug(
          `[Command] Mock result: ${rawMock !== undefined ? 'found' : 'not found'}, value=${JSON.stringify(rawMock)?.slice(0, 200)}`
        );
      }
      if (rawMock !== undefined) {
        // Normalize primitive mocks into object form
        let mock: any;
        if (typeof rawMock === 'number') {
          mock = { exit_code: Number(rawMock) };
        } else if (typeof rawMock === 'string') {
          mock = { stdout: String(rawMock) };
        } else {
          mock = rawMock as Record<string, unknown>;
        }
        const m = mock as { stdout?: string; stderr?: string; exit_code?: number; exit?: number };

        // Check if this looks like a command mock (has stdout/stderr/exit_code) or direct data output
        const isCommandMock =
          m.stdout !== undefined ||
          m.stderr !== undefined ||
          m.exit_code !== undefined ||
          m.exit !== undefined;

        let out: unknown;
        if (isCommandMock) {
          // Traditional command mock format: { stdout: "...", exit_code: 0 }
          out = m.stdout ?? '';
          try {
            if (
              typeof out === 'string' &&
              (out.trim().startsWith('{') || out.trim().startsWith('['))
            ) {
              out = JSON.parse(out);
            }
          } catch {}
        } else {
          // Direct data mock format: { data: [...], count: 1 } - use as-is
          out = mock;
        }

        const code = isCommandMock
          ? typeof m.exit_code === 'number'
            ? m.exit_code
            : typeof m.exit === 'number'
              ? m.exit
              : 0
          : 0;
        // For fail_if consistency, merge exit_code into the output if it's an object
        // This allows both `output.exit_code !== 0` and `output.failed > 0` patterns to work
        let outputWithMeta: unknown;
        if (isCommandMock) {
          if (out && typeof out === 'object' && !Array.isArray(out)) {
            // Merge exit_code into the parsed object (without overwriting existing fields)
            outputWithMeta = { ...(out as object), exit_code: code };
          } else {
            // For non-object outputs (string, array), wrap in a structure
            outputWithMeta = { value: out, exit_code: code };
          }
        } else {
          outputWithMeta = out;
        }
        if (code !== 0) {
          return {
            issues: [
              {
                file: 'command',
                line: 0,
                ruleId: 'command/execution_error',
                message: `Mocked command exited with code ${code}`,
                severity: 'error',
                category: 'logic',
              },
            ],
            output: outputWithMeta,
          } as any;
        }
        return { issues: [], output: outputWithMeta } as any;
      }
    } catch {}

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

      // Get timeout from config (in milliseconds) or use default (60 seconds = 60000ms)
      const timeoutMs = (config.timeout as number) || 60000;

      // Commands are executed via child_process.exec() which passes them through
      // /bin/sh -c, so multiline scripts (e.g. node -e '...') work correctly as-is.
      // The shell preserves newlines inside quoted arguments.
      const safeCommand = renderedCommand;

      // Determine working directory - use workspace if enabled, otherwise default
      const parentContext = (context as any)?._parentContext;
      const workingDirectory = parentContext?.workingDirectory;
      const workspaceEnabled = parentContext?.workspace?.isEnabled?.();
      const cwd = workspaceEnabled && workingDirectory ? workingDirectory : undefined;

      if (cwd) {
        logger.debug(`[command] Using workspace working directory: ${cwd}`);
      }

      // Use shared command executor
      const execResult = await commandExecutor.execute(safeCommand, {
        env: scriptEnv,
        timeout: timeoutMs,
        cwd,
      });

      const { stdout, stderr, exitCode } = execResult;

      if (stderr) {
        logger.debug(`Command stderr: ${stderr}`);
      }

      // Check for non-zero exit code
      if (exitCode !== 0) {
        const errorMessage = stderr || `Command exited with code ${exitCode}`;
        logger.error(`Command failed with exit code ${exitCode}: ${errorMessage}`);

        // Build error output so workflow tools can propagate errors to AI
        const errorOutput = {
          error: true,
          exit_code: exitCode,
          message: errorMessage,
          // Include stdout if present - may contain partial results or error details
          ...(stdout.trim() ? { stdout: stdout.trim() } : {}),
          // Include a text field for AI tool compatibility
          text: `Command failed with exit code ${exitCode}: ${errorMessage}`,
        };

        // Capture error output in telemetry so traces show what happened
        try {
          const span = trace.getSpan(otContext.active());
          if (span) {
            captureCheckOutput(span, errorOutput);
          }
        } catch {
          // Ignore telemetry errors
        }

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
          output: errorOutput,
        } as ReviewSummary & { output: unknown };
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

          // Capture Liquid transform in telemetry
          try {
            const span = trace.getSpan(otContext.active());
            if (span) {
              const { captureLiquidEvaluation } = require('../telemetry/state-capture');
              captureLiquidEvaluation(span, transform, transformContext, rendered);
            }
          } catch {
            // Ignore telemetry errors
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
            inputs: templateContext.inputs || {},
            env: templateContext.env,
            permissions: createPermissionHelpers(
              resolveAssociationFromEvent((prInfo as any).eventContext, prInfo.authorAssociation),
              detectLocalMode()
            ),
          };

          // Compile and execute the JavaScript expression
          // Use direct property access instead of destructuring to avoid syntax issues
          const trimmedTransform = transformJs.trim();
          // Build a safe function body that supports statements + implicit last-expression return.
          const buildBodyWithReturn = (raw: string): string => {
            const t = raw.trim();
            // Find last non-empty line
            const lines = t.split(/\n/);
            let i = lines.length - 1;
            while (i >= 0 && lines[i].trim().length === 0) i--;
            if (i < 0) return 'return undefined;';
            const lastLine = lines[i].trim();
            if (/^return\b/i.test(lastLine)) {
              return t;
            }
            const idx = t.lastIndexOf(lastLine);
            const head = idx >= 0 ? t.slice(0, idx) : '';
            const lastExpr = lastLine.replace(/;\s*$/, '');
            return `${head}\nreturn (${lastExpr});`;
          };
          const bodyWithReturn = buildBodyWithReturn(trimmedTransform);

          const code = `
            const output = scope.output;
            const pr = scope.pr;
            const files = scope.files;
            const outputs = scope.outputs;
            const inputs = scope.inputs;
            const env = scope.env;
            const log = (...args) => { console.log('🔍 Debug:', ...args); };
            const hasMinPermission = scope.permissions.hasMinPermission;
            const isOwner = scope.permissions.isOwner;
            const isMember = scope.permissions.isMember;
            const isCollaborator = scope.permissions.isCollaborator;
            const isContributor = scope.permissions.isContributor;
            const isFirstTimer = scope.permissions.isFirstTimer;
            const __result = (function(){
${bodyWithReturn}
            })();
            return __result;
          `;

          // Execute user code exclusively inside the sandbox
          if (!this.sandbox) {
            this.sandbox = this.createSecureSandbox();
          }
          // Try to serialize result to JSON string inside sandbox to preserve primitives like booleans
          let parsedFromSandboxJson: any = undefined;
          try {
            const stringifyCode = `
              const output = scope.output;
              const pr = scope.pr;
              const files = scope.files;
              const outputs = scope.outputs;
              const env = scope.env;
              const log = (...args) => { console.log('🔍 Debug:', ...args); };
              const hasMinPermission = scope.permissions.hasMinPermission;
              const isOwner = scope.permissions.isOwner;
              const isMember = scope.permissions.isMember;
              const isCollaborator = scope.permissions.isCollaborator;
              const isContributor = scope.permissions.isContributor;
              const isFirstTimer = scope.permissions.isFirstTimer;
              const __ret = (function(){
${bodyWithReturn}
              })();
              return typeof __ret === 'object' && __ret !== null ? JSON.stringify(__ret) : null;
            `;
            const stringifyExec = this.sandbox.compile(stringifyCode);
            const jsonStr = stringifyExec({ scope: jsContext }).run();
            if (typeof jsonStr === 'string' && jsonStr.trim().startsWith('{')) {
              parsedFromSandboxJson = JSON.parse(jsonStr);
            }
          } catch {}

          if (parsedFromSandboxJson !== undefined) {
            finalOutput = parsedFromSandboxJson;
          } else {
            finalOutput = compileAndRun<unknown>(
              this.sandbox,
              code,
              { scope: jsContext },
              { injectLog: false, wrapFunction: false }
            );
          }

          // Create a plain JSON snapshot of the transform result to avoid proxy/getter surprises
          // Prefer JSON stringify inside the sandbox realm (so it knows how to serialize its own objects),
          // then fall back to host-side JSON clone and finally to a shallow copy of own enumerable properties.
          let finalSnapshot: Record<string, unknown> | null = null;
          try {
            if (finalOutput && typeof finalOutput === 'object' && !Array.isArray(finalOutput)) {
              // Try realm-local stringify first
              try {
                const stringifyExec = this.sandbox!.compile('return JSON.stringify(scope.obj);');
                const jsonStr = stringifyExec({ obj: finalOutput }).run();
                if (typeof jsonStr === 'string' && jsonStr.trim().startsWith('{')) {
                  finalSnapshot = JSON.parse(jsonStr);
                }
              } catch {}
              if (!finalSnapshot) {
                try {
                  finalSnapshot = JSON.parse(JSON.stringify(finalOutput));
                } catch {}
              }
              if (!finalSnapshot) {
                const tmp: Record<string, unknown> = {};
                for (const k of Object.keys(finalOutput as Record<string, unknown>)) {
                  (tmp as any)[k] = (finalOutput as any)[k];
                }
                finalSnapshot = tmp;
              }
            }
          } catch {}
          // @ts-ignore store for later extraction path
          (this as any).__lastTransformSnapshot = finalSnapshot;
          try {
            const isObj =
              finalOutput && typeof finalOutput === 'object' && !Array.isArray(finalOutput);
            const keys = isObj
              ? Object.keys(finalOutput as Record<string, unknown>).join(',')
              : typeof finalOutput;
            logger.debug(
              `  transform_js: output typeof=${Array.isArray(finalOutput) ? 'array' : typeof finalOutput} keys=${keys}`
            );
            if (isObj && (finalOutput as any).issues) {
              const mi: any = (finalOutput as any).issues;
              logger.debug(
                `  transform_js: issues typeof=${Array.isArray(mi) ? 'array' : typeof mi} len=${(mi && mi.length) || 0}`
              );
            }
            try {
              if (isObj)
                logger.debug(`  transform_js: error value=${String((finalOutput as any).error)}`);
            } catch {}
          } catch {}

          logger.verbose(`✓ Applied JavaScript transform successfully`);
          // Already normalized in sandbox result
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
      // Capture a shallow snapshot created earlier if available (within transform_js path)
      // @ts-ignore - finalSnapshot is defined in the transform_js scope above when applicable
      // @ts-ignore retrieve snapshot captured after transform_js (if any)
      const snapshotForExtraction: Record<string, unknown> | null =
        (this as any).__lastTransformSnapshot || null;
      try {
        if (snapshotForExtraction) {
          logger.debug(`  provider: snapshot keys=${Object.keys(snapshotForExtraction).join(',')}`);
        } else {
          logger.debug(`  provider: snapshot is null`);
        }
      } catch {}
      // Some shells may wrap JSON output inside a one-element array due to quoting.
      // If we see a single-element array containing a JSON string or object, unwrap it.
      try {
        if (Array.isArray(outputForDependents) && (outputForDependents as unknown[]).length === 1) {
          const first = (outputForDependents as unknown[])[0];
          if (typeof first === 'string') {
            try {
              outputForDependents = JSON.parse(first);
            } catch {}
          } else if (first && typeof first === 'object') {
            outputForDependents = first as unknown;
          }
        }
      } catch {}

      let content: string | undefined;
      let extracted: { issues: ReviewIssue[]; remainingOutput: unknown } | null = null;

      const trimmedRawOutput = typeof rawOutput === 'string' ? rawOutput.trim() : undefined;

      const commandConfig = config as CheckProviderConfig & { forEach?: boolean };
      const isForEachParent = commandConfig.forEach === true;

      if (!isForEachParent) {
        // Generic: if transform output is an object and contains an 'issues' field,
        // expose all other fields to dependents regardless of whether we successfully
        // normalized the issues array. This preserves flags like 'error' for fail_if.
        try {
          const baseObj = (snapshotForExtraction || (finalOutput as any)) as Record<
            string,
            unknown
          >;
          if (
            baseObj &&
            typeof baseObj === 'object' &&
            Object.prototype.hasOwnProperty.call(baseObj, 'issues')
          ) {
            const remaining = { ...baseObj } as Record<string, unknown>;
            delete (remaining as any).issues;
            outputForDependents = Object.keys(remaining).length > 0 ? remaining : undefined;
            try {
              const k =
                outputForDependents && typeof outputForDependents === 'object'
                  ? Object.keys(outputForDependents as any).join(',')
                  : String(outputForDependents);
              logger.debug(`  provider: generic-remaining keys=${k}`);
            } catch {}
          }
        } catch {}
        // Fast path for transform_js objects that include an issues array (realm-agnostic)
        const objForExtraction = (snapshotForExtraction || (finalOutput as any)) as Record<
          string,
          unknown
        >;
        if (objForExtraction && typeof objForExtraction === 'object') {
          try {
            const rec = objForExtraction;
            const maybeIssues: any = (rec as any).issues;
            const toPlainArray = (v: any): any[] | null => {
              if (Array.isArray(v)) return v;
              try {
                if (v && typeof v === 'object' && typeof v[Symbol.iterator] === 'function') {
                  return Array.from(v);
                }
              } catch {}
              const len = Number((v || {}).length);
              if (Number.isFinite(len) && len >= 0) {
                const arr: any[] = [];
                for (let i = 0; i < len; i++) arr.push(v[i]);
                return arr;
              }
              try {
                const cloned = JSON.parse(JSON.stringify(v));
                return Array.isArray(cloned) ? cloned : null;
              } catch {
                return null;
              }
            };
            try {
              const ctor =
                maybeIssues && (maybeIssues as any).constructor
                  ? (maybeIssues as any).constructor.name
                  : 'unknown';
              logger.debug(
                `  provider: issues inspect typeof=${typeof maybeIssues} Array.isArray=${Array.isArray(
                  maybeIssues
                )} ctor=${ctor} keys=${Object.keys((maybeIssues || {}) as any).join(',')}`
              );
            } catch {}
            const arr = toPlainArray(maybeIssues);
            if (arr) {
              const norm = this.normalizeIssueArray(arr);
              if (norm) {
                issues = norm;
                const remaining = { ...rec } as Record<string, unknown>;
                delete (remaining as any).issues;
                outputForDependents = Object.keys(remaining).length > 0 ? remaining : undefined;
                try {
                  const keys =
                    outputForDependents && typeof outputForDependents === 'object'
                      ? Object.keys(outputForDependents as any).join(',')
                      : String(outputForDependents);
                  logger.info(
                    `  provider: fast-path issues=${issues.length} remaining keys=${keys}`
                  );
                } catch {}
              } else {
                try {
                  logger.info('  provider: fast-path norm failed');
                } catch {}
              }
            } else {
              try {
                logger.info('  provider: fast-path arr unavailable');
              } catch {}
            }
          } catch {}
        }
        // Normalize extraction target: unwrap one-element arrays like ["{...}"] or [{...}]
        let extractionTarget: unknown = snapshotForExtraction || finalOutput;
        try {
          if (Array.isArray(extractionTarget) && (extractionTarget as unknown[]).length === 1) {
            const first = (extractionTarget as unknown[])[0];
            if (typeof first === 'string') {
              try {
                extractionTarget = JSON.parse(first);
              } catch {
                extractionTarget = first;
              }
            } else if (first && typeof first === 'object') {
              extractionTarget = first as unknown;
            }
          }
        } catch {}
        extracted = this.extractIssuesFromOutput(extractionTarget);
        try {
          if (extractionTarget !== (snapshotForExtraction || finalOutput)) {
            finalOutput = extractionTarget;
          }
        } catch {}
        // no debug
        // Handle cross-realm Arrays from sandbox: issues may look like an array but fail Array.isArray
        if (!extracted && finalOutput && typeof finalOutput === 'object') {
          try {
            const rec = finalOutput as Record<string, unknown>;
            const maybeIssues: any = (rec as any).issues;
            if (maybeIssues && typeof maybeIssues === 'object') {
              let arr: any[] | null = null;
              // Prefer iterator if present
              try {
                if (typeof maybeIssues[Symbol.iterator] === 'function') {
                  arr = Array.from(maybeIssues);
                }
              } catch {}
              // Fallback to length-based copy
              if (!arr) {
                const len = Number((maybeIssues as any).length);
                if (Number.isFinite(len) && len >= 0) {
                  arr = [];
                  for (let i = 0; i < len; i++) arr.push(maybeIssues[i]);
                }
              }
              // Last resort: JSON clone
              if (!arr) {
                try {
                  arr = JSON.parse(JSON.stringify(maybeIssues));
                } catch {}
              }
              if (arr && Array.isArray(arr)) {
                const norm = this.normalizeIssueArray(arr);
                if (norm) {
                  issues = norm;
                  const remaining = { ...rec } as Record<string, unknown>;
                  delete (remaining as any).issues;
                  outputForDependents = Object.keys(remaining).length > 0 ? remaining : undefined;
                }
              }
            }
          } catch {}
        }
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

        // Generic fallback: if issues are still empty, try to parse raw stdout as JSON and extract issues.
        if (!issues.length && typeof trimmedRawOutput === 'string') {
          try {
            const tryParsed = JSON.parse(trimmedRawOutput);
            const reextract = this.extractIssuesFromOutput(tryParsed);
            if (reextract && reextract.issues && reextract.issues.length) {
              issues = reextract.issues;
              if (!outputForDependents && reextract.remainingOutput) {
                outputForDependents = reextract.remainingOutput;
              }
            } else if (Array.isArray(tryParsed)) {
              // Treat parsed array as potential issues array or array of { issues: [...] }
              const first = tryParsed[0];
              if (first && typeof first === 'object' && Array.isArray((first as any).issues)) {
                const merged: unknown[] = [];
                for (const el of tryParsed as unknown[]) {
                  if (el && typeof el === 'object' && Array.isArray((el as any).issues)) {
                    merged.push(...((el as any).issues as unknown[]));
                  }
                }
                const flat = this.normalizeIssueArray(merged);
                if (flat) issues = flat;
              } else {
                // Try to parse string elements into JSON objects and extract
                const converted: unknown[] = [];
                for (const el of tryParsed as unknown[]) {
                  if (typeof el === 'string') {
                    try {
                      const obj = JSON.parse(el);
                      converted.push(obj);
                    } catch {
                      // keep as-is
                    }
                  } else {
                    converted.push(el);
                  }
                }
                const flat = this.normalizeIssueArray(converted as unknown[]);
                if (flat) issues = flat;
              }
            }
          } catch {}
          if (!issues.length) {
            try {
              const any = this.extractJsonAnywhere(trimmedRawOutput);
              if (any) {
                const tryParsed = JSON.parse(any);
                const reextract = this.extractIssuesFromOutput(tryParsed);
                if (reextract && reextract.issues && reextract.issues.length) {
                  issues = reextract.issues;
                  if (!outputForDependents && reextract.remainingOutput) {
                    outputForDependents = reextract.remainingOutput;
                  }
                }
              }
            } catch {}
          }
        }

        // Preserve all primitive flags (boolean/number/string) from original transform output
        try {
          const srcObj = (snapshotForExtraction || (finalOutput as any)) as Record<string, unknown>;
          if (
            outputForDependents &&
            typeof outputForDependents === 'object' &&
            srcObj &&
            typeof srcObj === 'object'
          ) {
            for (const k of Object.keys(srcObj)) {
              const v: any = (srcObj as any)[k];
              if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
                (outputForDependents as any)[k] = v;
              }
            }
          }
        } catch {}

        // Normalize output object to a plain shallow object (avoid JSON stringify drop of false booleans)
        try {
          if (
            outputForDependents &&
            typeof outputForDependents === 'object' &&
            !Array.isArray(outputForDependents)
          ) {
            const plain: Record<string, unknown> = {};
            for (const k of Object.keys(outputForDependents as any)) {
              (plain as any)[k] = (outputForDependents as any)[k];
            }
            outputForDependents = plain;
          }
        } catch {}
      }

      if (!content && this.shouldTreatAsTextOutput(trimmedRawOutput) && !isForEachParent) {
        content = trimmedRawOutput;
      }

      // Normalize output object to plain JSON to avoid cross-realm proxy quirks
      try {
        if (outputForDependents && typeof outputForDependents === 'object') {
          outputForDependents = JSON.parse(JSON.stringify(outputForDependents));
        }
      } catch {}

      // Promote primitive flags from original transform output to top-level result fields (schema-agnostic)
      const promoted: Record<string, unknown> = {};
      try {
        const srcObj = (snapshotForExtraction || (finalOutput as any)) as Record<string, unknown>;
        if (srcObj && typeof srcObj === 'object') {
          for (const k of Object.keys(srcObj)) {
            const v: any = (srcObj as any)[k];
            if (typeof v === 'boolean') {
              if (v === true && promoted[k] === undefined) promoted[k] = true;
            } else if (
              (typeof v === 'number' || typeof v === 'string') &&
              promoted[k] === undefined
            ) {
              promoted[k] = v;
            }
          }
        }
      } catch {}

      // Return the output and issues as part of the review summary so dependent checks can use them
      const result = {
        issues,
        output: outputForDependents,
        ...(content ? { content } : {}),
        ...promoted,
      } as ReviewSummary;

      // Capture output and transform details in active OTEL span
      try {
        const span = trace.getSpan(otContext.active());
        if (span) {
          captureCheckOutput(span, outputForDependents);
          if (transformJs && output !== finalOutput) {
            captureTransformJS(span, transformJs, output, finalOutput);
          }
        }
      } catch {
        // Ignore telemetry errors
      }
      // Fallback NDJSON for output (non-OTEL environments)
      try {
        const checkId = (config as any).checkName || (config as any).id || 'unknown';
        const outJson = JSON.stringify((result as any).output ?? result);
        const { emitNdjsonSpanWithEvents } = require('../telemetry/fallback-ndjson');
        emitNdjsonSpanWithEvents(
          'visor.check',
          { 'visor.check.id': checkId, 'visor.check.output': outJson },
          [{ name: 'check.started' }, { name: 'check.completed' }]
        );
      } catch {}

      // Attach raw transform object only when transform_js was used (avoid polluting plain command outputs)
      try {
        if (transformJs) {
          const rawObj = (snapshotForExtraction || (finalOutput as any)) as Record<string, unknown>;
          if (rawObj && typeof rawObj === 'object') {
            (result as any).__raw = rawObj;
          }
        }
      } catch {}

      // Final safeguard: ensure primitive flags from original transform output are present in result.output.
      // Do this without dropping explicit false values (important for fail_if like `output.error`).
      try {
        const srcObj = (snapshotForExtraction || (finalOutput as any)) as Record<string, unknown>;
        const srcErr = ((): boolean | undefined => {
          try {
            if (
              snapshotForExtraction &&
              typeof snapshotForExtraction === 'object' &&
              (snapshotForExtraction as any).error !== undefined
            ) {
              return Boolean((snapshotForExtraction as any).error);
            }
            if (
              finalOutput &&
              typeof finalOutput === 'object' &&
              (finalOutput as any).error !== undefined
            ) {
              return Boolean((finalOutput as any).error);
            }
          } catch {}
          return undefined;
        })();
        const dst = (result as any).output;
        if (srcObj && typeof srcObj === 'object' && dst && typeof dst === 'object') {
          try {
            logger.debug(
              `  provider: safeguard src.error typeof=${typeof (srcObj as any).error} val=${String((srcObj as any).error)} dst.hasErrorBefore=${String((dst as any).error !== undefined)}`
            );
          } catch {}
          for (const k of Object.keys(srcObj)) {
            const v: any = (srcObj as any)[k];
            if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
              (dst as any)[k] = v;
            }
          }
          // Explicitly normalize a common flag used in tests/pipelines
          if (srcErr !== undefined && (dst as any).error === undefined) {
            (dst as any).error = srcErr;
            try {
              const k = Object.keys(dst as any).join(',');
              logger.debug(
                `  provider: safeguard merged error -> output keys=${k} val=${String((dst as any).error)}`
              );
            } catch {}
          }
        }
      } catch {}

      try {
        const out: any = (result as any).output;
        if (out && typeof out === 'object') {
          const k = Object.keys(out as Record<string, unknown>).join(',');
          logger.debug(`  provider: return output keys=${k}`);
        } else {
          logger.debug(`  provider: return output type=${typeof out}`);
        }
      } catch {}

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
      // Fallback: detect timeout based on error message text
      if (!isTimeout && error instanceof Error) {
        if (/timed out/i.test(error.message)) {
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
        const timeoutMs = (config.timeout as number) || 60000;
        detailedMessage = `Command execution timed out after ${timeoutMs} milliseconds`;
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

      // Build error output so workflow tools can propagate errors to AI
      const errorOutput = {
        error: true,
        timeout: isTimeout,
        message: detailedMessage,
        text: detailedMessage,
      };

      // Capture error output in telemetry
      try {
        const span = trace.getSpan(otContext.active());
        if (span) {
          captureCheckOutput(span, errorOutput);
        }
      } catch {
        // Ignore telemetry errors
      }

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
        output: errorOutput,
      } as ReviewSummary & { output: unknown };
    }
  }

  private buildOutputContext(
    dependencyResults?: Map<string, ReviewSummary>,
    outputHistory?: Map<string, unknown[]>
  ): Record<string, unknown> {
    if (!dependencyResults) {
      return {};
    }

    const outputs: Record<string, unknown> = {};
    const history: Record<string, unknown[]> = {};

    for (const [checkName, result] of dependencyResults) {
      // If the result has a direct output field, use it directly
      // Otherwise, expose the entire result as-is
      const summary = result as ReviewSummary & { output?: unknown };
      const value = summary.output !== undefined ? summary.output : summary;
      outputs[checkName] = this.makeJsonSmart(value);
    }

    // Add history for each check if available
    if (outputHistory) {
      for (const [checkName, historyArray] of outputHistory) {
        history[checkName] = historyArray.map(val => this.makeJsonSmart(val));
      }
    }

    // Attach history to the outputs object
    (outputs as any).history = history;

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
      s = s.replace(/:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,}])/g, (_match, word) => {
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
    const { buildSandboxEnv } = require('../utils/env-exposure');
    const merged = buildSandboxEnv(process.env);
    for (const [key, value] of Object.entries(merged)) {
      safeVars[key] = String(value);
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
      // Two supported shapes:
      //  1) Array<ReviewIssue-like>
      //  2) Array<{ issues: Array<ReviewIssue-like> }>
      const first = output[0];
      if (
        first &&
        typeof first === 'object' &&
        !Array.isArray((first as any).message) &&
        Array.isArray((first as any).issues)
      ) {
        // flatten nested issues arrays
        const merged: unknown[] = [];
        for (const el of output as unknown[]) {
          if (el && typeof el === 'object' && Array.isArray((el as any).issues)) {
            merged.push(...((el as any).issues as unknown[]));
          }
        }
        const flat = this.normalizeIssueArray(merged);
        if (flat) return { issues: flat, remainingOutput: undefined };
      } else {
        const issues = this.normalizeIssueArray(output);
        if (issues) {
          return { issues, remainingOutput: undefined };
        }
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

    // Require at least one issue-specific field beyond just a message-like field.
    // This prevents objects like {text: "..."} from being treated as issues.
    const hasIssueField =
      data.file !== undefined ||
      data.path !== undefined ||
      data.filename !== undefined ||
      data.line !== undefined ||
      data.startLine !== undefined ||
      data.lineNumber !== undefined ||
      data.severity !== undefined ||
      data.level !== undefined ||
      data.priority !== undefined ||
      data.ruleId !== undefined ||
      data.rule !== undefined ||
      data.category !== undefined ||
      data.type !== undefined;
    if (!hasIssueField) {
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
      // Best-effort compatibility: allow double-quoted bracket keys inside Liquid tags.
      // e.g., {{ outputs["fetch-tickets"].key }} → {{ outputs['fetch-tickets'].key }}
      let tpl = template;
      if (tpl.includes('{{')) {
        tpl = tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner) => {
          const fixed = String(inner).replace(/\[\"/g, "['").replace(/\"\]/g, "']");
          return `{{ ${fixed} }}`;
        });
      }
      let rendered = await this.liquid.parseAndRender(tpl, context);
      // If Liquid left unresolved tags (common when users write JS expressions inside {{ }}),
      // fall back to a safe JS-expression renderer for the remaining tags.
      if (/\{\{[\s\S]*?\}\}/.test(rendered)) {
        try {
          rendered = this.renderWithJsExpressions(rendered, context);
        } catch {
          // keep Liquid-rendered result as-is
        }
      }
      return rendered;
    } catch (error) {
      logger.debug(`🔧 Debug: Liquid templating failed, trying JS-expression fallback: ${error}`);
      try {
        return this.renderWithJsExpressions(template, context);
      } catch {
        return template;
      }
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
