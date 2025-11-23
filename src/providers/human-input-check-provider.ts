import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { HumanInputRequest } from '../types/config';
import { interactivePrompt, simplePrompt } from '../utils/interactive-prompt';
import { getPromptStateManager } from '../slack/prompt-state';
import { createExtendedLiquid } from '../liquid-extensions';
import { tryReadStdin } from '../utils/stdin-reader';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Human input check provider that pauses workflow to request user input.
 *
 * Supports four modes:
 * 1. CLI with --message argument (inline or file path)
 * 2. CLI with piped stdin
 * 3. CLI interactive mode (beautiful terminal UI)
 * 4. SDK mode with onHumanInput hook
 *
 * Example config:
 * ```yaml
 * checks:
 *   approval:
 *     type: human-input
 *     prompt: "Do you approve? (yes/no)"
 *     allow_empty: false
 *     timeout: 300000
 * ```
 */
export class HumanInputCheckProvider extends CheckProvider {
  private liquid?: ReturnType<typeof createExtendedLiquid>;
  /**
   * @deprecated Use ExecutionContext.cliMessage instead
   * Kept for backward compatibility
   */
  private static cliMessage: string | undefined;

  /**
   * @deprecated Use ExecutionContext.hooks instead
   * Kept for backward compatibility
   */
  private static hooks: { onHumanInput?: (request: HumanInputRequest) => Promise<string> } = {};

  /**
   * Set the CLI message value (from --message argument)
   * @deprecated Use ExecutionContext.cliMessage instead
   */
  static setCLIMessage(message: string | undefined): void {
    HumanInputCheckProvider.cliMessage = message;
  }

  /**
   * Get the current CLI message value
   * @deprecated Use ExecutionContext.cliMessage instead
   */
  static getCLIMessage(): string | undefined {
    return HumanInputCheckProvider.cliMessage;
  }

  /**
   * Set hooks for SDK mode
   * @deprecated Use ExecutionContext.hooks instead
   */
  static setHooks(hooks: { onHumanInput?: (request: HumanInputRequest) => Promise<string> }): void {
    HumanInputCheckProvider.hooks = hooks;
  }

  getName(): string {
    return 'human-input';
  }

  getDescription(): string {
    return 'Prompts for human input during workflow execution (CLI interactive or SDK hook)';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'human-input'
    if (cfg.type !== 'human-input') {
      return false;
    }

    // Prompt is required
    if (!cfg.prompt || typeof cfg.prompt !== 'string') {
      console.error('human-input check requires a "prompt" field');
      return false;
    }

    return true;
  }

  /** Build a template context for Liquid rendering */
  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    outputHistory?: Map<string, unknown[]>,
    _context?: ExecutionContext
  ): Record<string, unknown> {
    const ctx: Record<string, unknown> = {};
    // pr context
    try {
      ctx.pr = {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        base: prInfo.base,
        head: prInfo.head,
        files: (prInfo.files || []).map(f => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      };
    } catch {}
    // event + env
    try {
      const safeEnv = (() => {
        try {
          const { buildSandboxEnv } = require('../utils/env-exposure');
          return buildSandboxEnv(process.env);
        } catch {
          return {} as Record<string, string>;
        }
      })();
      (ctx as any).event = { event_name: (prInfo as any)?.eventType || 'manual' };
      (ctx as any).env = safeEnv;
    } catch {}
    // utils helpers
    (ctx as any).utils = {
      now: new Date().toISOString(),
      today: new Date().toISOString().split('T')[0],
    };
    // outputs: expose raw outputs from dependency results
    const outputs: Record<string, unknown> = {};
    const outputsRaw: Record<string, unknown> = {};
    if (dependencyResults) {
      for (const [name, res] of dependencyResults.entries()) {
        const summary = res as ReviewSummary & { output?: unknown };
        if (typeof name === 'string' && name.endsWith('-raw')) {
          outputsRaw[name.slice(0, -4)] = summary.output !== undefined ? summary.output : summary;
        } else {
          outputs[name] = summary.output !== undefined ? summary.output : summary;
        }
      }
    }
    ctx.outputs = outputs;
    (ctx as any).outputs_raw = outputsRaw;
    // outputs_history: expose full history if available
    const hist: Record<string, unknown[]> = {};
    if (outputHistory) {
      for (const [k, v] of outputHistory.entries()) hist[k] = Array.isArray(v) ? v : [];
    }
    (ctx as any).outputs_history = hist;

    // Optional: expose checks metadata for helpers like chat_history
    try {
      const anyCtx = _context as any;
      const checksMeta = anyCtx?.checksMeta;
      if (checksMeta && typeof checksMeta === 'object') {
        (ctx as any).checks_meta = checksMeta;
      }
    } catch {
      // Best-effort only
    }
    return ctx;
  }

  /**
   * Check if a string looks like a file path
   */
  private looksLikePath(str: string): boolean {
    return str.includes('/') || str.includes('\\');
  }

  /**
   * Sanitize user input to prevent injection attacks in dependent checks
   * Removes potentially dangerous characters while preserving useful input
   */
  private sanitizeInput(input: string): string {
    // Heuristic: collapse accidental per-character duplication ("stutter") often caused by
    // TTY echo races. We only apply this when most adjacent ASCII chars are doubled.
    const collapseStutter = (s: string): string => {
      if (!s || s.length < 4) return s;
      let dupPairs = 0;
      let pairs = 0;
      for (let i = 0; i + 1 < s.length; i++) {
        const a = s[i];
        const b = s[i + 1];
        if (/^[\x20-\x7E]$/.test(a) && /^[\x20-\x7E]$/.test(b)) {
          pairs++;
          if (a === b) dupPairs++;
        }
      }
      const ratio = pairs > 0 ? dupPairs / pairs : 0;
      if (ratio < 0.5) return s; // keep as-is unless roughly half of pairs are doubled
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const a = s[i];
        const b = i + 1 < s.length ? s[i + 1] : '';
        if (b && a === b) {
          out += a;
          i++; // skip the duplicate
        } else {
          out += a;
        }
      }
      return out;
    };

    input = collapseStutter(input);
    // Remove null bytes (C-string injection)
    let sanitized = input.replace(/\0/g, '');

    // Remove control characters except newlines and tabs
    sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

    // Limit length to prevent memory issues (100KB max)
    const maxLength = 100 * 1024;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }

    return sanitized;
  }

  /**
   * Try to read message from file if it exists
   * Validates path to prevent directory traversal attacks
   */
  private async tryReadFile(filePath: string): Promise<string | null> {
    try {
      // Handle both absolute and relative paths
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);

      // Normalize path to resolve .. and . components
      const normalizedPath = path.normalize(absolutePath);

      // Security: Prevent path traversal attacks
      // Only allow files within current working directory or its subdirectories
      const cwd = process.cwd();
      if (!normalizedPath.startsWith(cwd + path.sep) && normalizedPath !== cwd) {
        // Path is outside working directory
        return null;
      }

      // Use async file access check instead of sync existsSync
      try {
        await fs.promises.access(normalizedPath, fs.constants.R_OK);
        const stats = await fs.promises.stat(normalizedPath);

        // Only read regular files, not directories or special files
        if (!stats.isFile()) {
          return null;
        }

        const content = await fs.promises.readFile(normalizedPath, 'utf-8');
        return content.trim();
      } catch {
        // File doesn't exist or isn't readable
        return null;
      }
    } catch {
      // If file read fails, treat as literal string
    }
    return null;
  }

  /**
   * Get user input through various methods
   */
  private async getUserInput(
    checkName: string,
    config: CheckProviderConfig,
    context?: ExecutionContext
  ): Promise<string> {
    // Slack event-bus path: if this run comes from a Slack event, support pause/resume via PromptState
    try {
      const payload = context?.webhookContext?.webhookData?.get(
        ((config as any)?.endpoint as string) || '/bots/slack/support'
      ) as any;
      const ev: any = payload && payload.event;
      const channel = ev && String(ev.channel || '');
      const threadTs = ev && String(ev.thread_ts || ev.ts || ev.event_ts || '');
      const text = ev && String(ev.text || '');
      if (channel && threadTs) {
        const mgr = getPromptStateManager();
        // First-run optimization: consume the first message only if no prompts were posted yet
        // and the thread has an unconsumed first message captured by the socket.
        try {
          const waiting = mgr.getWaiting(channel, threadTs);
          const promptsPosted = waiting?.promptsPosted || 0;
          if (promptsPosted === 0 && mgr.hasUnconsumedFirstMessage(channel, threadTs)) {
            const first = mgr.consumeFirstMessage(channel, threadTs);
            if (first && first.trim().length > 0) {
              return first;
            }
          }
        } catch {}
        const waiting = mgr.getWaiting(channel, threadTs);
        if (waiting && waiting.checkName === checkName) {
          // Resume: consume current Slack message as the answer
          const answer = text.replace(/<@[A-Z0-9]+>/gi, '').trim();
          mgr.clear(channel, threadTs);
          if (!answer && (config.allow_empty as boolean | undefined) !== true) {
            // fall through to CLI path if empty not allowed
          } else {
            return answer || (config.default as string) || '';
          }
        } else {
          // First time: request human input via event bus; Slack frontend will post and mark waiting
          const prompt = String((config.prompt as string) || 'Please provide input:');
          try {
            await context?.eventBus?.emit({
              type: 'HumanInputRequested',
              checkId: checkName,
              prompt,
              channel,
              threadTs,
              threadKey: `${channel}:${threadTs}`,
            });
          } catch {}
          // Return a fatal error so the run pauses and relies on snapshot/resume.
          // This prevents the router from immediately looping back to `ask` while
          // we wait for the next Slack message in the same thread.
          throw this.buildAwaitingError(checkName, prompt);
        }
      }
    } catch (e) {
      // If we constructed an awaiting error, bubble it so the caller can treat it as fatal
      if (e && (e as any).issues) throw e;
      // Otherwise swallow and continue to CLI fallbacks
    }
    // Test runner mock support: if a mock is provided for this step, use it
    try {
      const mockVal = context?.hooks?.mockForStep?.(checkName);
      if (mockVal !== undefined && mockVal !== null) {
        const s = String(mockVal);
        return s;
      }
    } catch {}
    const prompt = (config.prompt as string) || 'Please provide input:';
    const placeholder = (config.placeholder as string | undefined) || 'Enter your response...';
    const allowEmpty = (config.allow_empty as boolean | undefined) ?? false;
    const multiline = (config.multiline as boolean | undefined) ?? false;
    const timeout = config.timeout ? config.timeout * 1000 : undefined; // Convert to ms
    const defaultValue = config.default as string | undefined;

    // In test/CI modes, never block for input. Use default or empty string.
    const testMode = String(process.env.VISOR_TEST_MODE || '').toLowerCase() === 'true';
    const ciMode =
      String(process.env.CI || '').toLowerCase() === 'true' ||
      String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
    if (testMode || ciMode) {
      const val = (config.default as string | undefined) || '';
      return val;
    }

    // Get cliMessage from context (new way) or static property (backward compat)
    const cliMessage = context?.cliMessage ?? HumanInputCheckProvider.cliMessage;

    // Priority 1: Check for --message CLI argument
    if (cliMessage !== undefined) {
      const message = cliMessage;

      // Check if it looks like a path and try to read the file
      if (this.looksLikePath(message)) {
        const fileContent = await this.tryReadFile(message);
        if (fileContent !== null) {
          return fileContent;
        }
      }

      // Otherwise, use as literal message
      return message;
    }

    // Priority 2: Check for piped stdin
    const stdinInput = await tryReadStdin(timeout);
    if (stdinInput !== null && stdinInput.length > 0) {
      return stdinInput;
    }

    // Priority 3: SDK hook mode
    // Get hooks from context (new way) or static property (backward compat)
    const hooks = context?.hooks ?? HumanInputCheckProvider.hooks;

    if (hooks?.onHumanInput) {
      const request: HumanInputRequest = {
        checkId: checkName,
        prompt,
        placeholder,
        allowEmpty,
        multiline,
        timeout,
        default: defaultValue,
      };

      try {
        const result = await hooks.onHumanInput(request);
        return result;
      } catch (error) {
        throw new Error(
          `Hook onHumanInput failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Priority 4: Interactive terminal prompt (if TTY available)
    if (process.stdin.isTTY) {
      try {
        const result = await interactivePrompt({
          prompt,
          placeholder,
          multiline,
          timeout,
          defaultValue,
          allowEmpty,
        });
        return result;
      } catch (error) {
        throw new Error(
          `Interactive prompt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Priority 5: Simple prompt (fallback for non-TTY)
    try {
      const result = await simplePrompt(prompt);
      if (!result && !allowEmpty && !defaultValue) {
        throw new Error('Empty input not allowed');
      }
      return result || defaultValue || '';
    } catch (error) {
      throw new Error(
        `Simple prompt failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Build a deterministic, fatal error used to pause Slack-driven runs. */
  private buildAwaitingError(checkName: string, prompt: string): Error {
    const err = new Error(`awaiting human input for ${checkName}`);
    (err as any).issues = [
      {
        file: 'system',
        line: 0,
        ruleId: `${checkName}/execution_error`,
        message: `Awaiting human input (Slack thread): ${prompt.slice(0, 80)}`,
        severity: 'error',
        category: 'logic',
      },
    ] as ReviewSummary['issues'];
    return err;
  }

  async execute(
    _prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkName = config.checkName || 'human-input';

    try {
      // Render Liquid templates in prompt/placeholder if any
      try {
        this.liquid =
          this.liquid || createExtendedLiquid({ strictVariables: false, strictFilters: false });
        const tctx = this.buildTemplateContext(
          _prInfo,
          _dependencyResults,
          (config as any).__outputHistory as Map<string, unknown[]> | undefined,
          context
        );
        if (typeof config.prompt === 'string') {
          let rendered = await this.liquid.parseAndRender(config.prompt, tctx);
          // If Liquid markers remain (e.g., due to nested/guarded templates), try a second pass
          if (/\{\{|\{%/.test(rendered)) {
            try {
              rendered = await this.liquid.parseAndRender(rendered, tctx);
            } catch {}
          }
          // Expose the final rendered prompt to the test runner (like AI provider does)
          try {
            const stepName = (config as any).checkName || 'unknown';
            context?.hooks?.onPromptCaptured?.({
              step: String(stepName),
              provider: 'human-input',
              prompt: rendered,
            });
          } catch {}
          config = { ...config, prompt: rendered };
        }
        if (typeof config.placeholder === 'string') {
          let ph = await this.liquid.parseAndRender(config.placeholder as string, tctx);
          if (/\{\{|\{%/.test(ph)) {
            try {
              ph = await this.liquid.parseAndRender(ph, tctx);
            } catch {}
          }
          (config as any).placeholder = ph;
        }
      } catch (e) {
        // Always show Liquid errors with a helpful snippet and caret
        const err: any = e || {};
        const raw = String((config as any)?.prompt || '');
        const lines = raw.split(/\r?\n/);
        const lineNum: number = Number(err.line || err?.token?.line || err?.location?.line || 0);
        const colNum: number = Number(err.col || err?.token?.col || err?.location?.col || 0);
        let snippet = '';
        if (lineNum > 0) {
          const start = Math.max(1, lineNum - 3);
          const end = Math.max(lineNum + 2, lineNum);
          const width = String(end).length;
          for (let i = start; i <= Math.min(end, lines.length); i++) {
            const ln = `${String(i).padStart(width, ' ')} | ${lines[i - 1] ?? ''}`;
            snippet += ln + '\n';
            if (i === lineNum) {
              const caretPad = ' '.repeat(Math.max(0, colNum > 1 ? colNum - 1 : 0) + width + 3);
              snippet += caretPad + '^\n';
            }
          }
        }
        try {
          console.error(
            `⚠️  human-input: Liquid render failed: ${
              e instanceof Error ? e.message : String(e)
            }\n${snippet}`
          );
        } catch {}
        // Continue with raw strings as a fallback
      }
      // Get user input (pass context for non-static state)
      const userInput = await this.getUserInput(checkName, config, context);

      // Sanitize input to prevent injection attacks in dependent checks
      const sanitizedInput = this.sanitizeInput(userInput);

      // Return structured output with timestamp for consistent history/merging
      return {
        issues: [],
        output: { text: sanitizedInput, ts: Date.now() },
      } as ReviewSummary & { output: { text: string; ts: number } };
    } catch (error) {
      // If slack pause/resume threw a fatal error with issues, surface as-is
      if (error && (error as any).issues) {
        // Mark this summary as "awaiting human input" so the engine can
        // treat it as a pause point and avoid running downstream checks
        // in the same wave (especially for Slack SocketMode flows).
        const summary: ReviewSummary & { awaitingHumanInput?: boolean } = {
          issues: (error as any).issues,
        } as ReviewSummary & { awaitingHumanInput?: boolean };
        (summary as any).awaitingHumanInput = true;
        return summary;
      }
      // Otherwise, return a generic error issue
      return {
        issues: [
          {
            file: '',
            line: 0,
            ruleId: 'human-input-error',
            message: `Failed to get user input: ${
              error instanceof Error ? error.message : String(error)
            }`,
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
      'prompt',
      'placeholder',
      'allow_empty',
      'multiline',
      'timeout',
      'default',
      'depends_on',
      'on',
      'if',
      'group',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Human input provider is always available
    // It will fall back to simple prompts if interactive mode isn't available
    return true;
  }

  getRequirements(): string[] {
    return [
      'No external dependencies required',
      'Works in CLI mode with --message argument, piped stdin, or interactive prompts',
      'SDK mode requires onHumanInput hook to be configured',
    ];
  }
}
