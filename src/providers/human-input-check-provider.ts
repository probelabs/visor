import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { HumanInputRequest } from '../types/config';
import { interactivePrompt, simplePrompt } from '../utils/interactive-prompt';
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
    const prompt = config.prompt || 'Please provide input:';
    const placeholder = (config.placeholder as string | undefined) || 'Enter your response...';
    const allowEmpty = (config.allow_empty as boolean | undefined) ?? false;
    const multiline = (config.multiline as boolean | undefined) ?? false;
    const timeout = config.timeout ? config.timeout * 1000 : undefined; // Convert to ms
    const defaultValue = config.default as string | undefined;

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

  async execute(
    _prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const checkName = config.checkName || 'human-input';

    try {
      // Get user input (pass context for non-static state)
      const userInput = await this.getUserInput(checkName, config, context);

      // Sanitize input to prevent injection attacks in dependent checks
      const sanitizedInput = this.sanitizeInput(userInput);

      // Return the input as the check output (stored in output field for dependent checks)
      return {
        issues: [],
        output: sanitizedInput,
      } as ReviewSummary & { output: string };
    } catch (error) {
      // If there's an error getting input, return an error issue
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
