import { Command } from 'commander';
import { CliOptions, CheckType, OutputFormat } from './types/cli';
import * as fs from 'fs';
import * as path from 'path';

/**
 * CLI argument parser and command handler
 */
export class CLI {
  private program: Command;
  private validChecks: CheckType[] = ['performance', 'architecture', 'security', 'style', 'all'];
  private validOutputs: OutputFormat[] = ['table', 'json', 'markdown', 'sarif'];

  constructor() {
    this.program = new Command();
    this.setupProgram();
  }

  /**
   * Set up the commander program with options and validation
   */
  private setupProgram(): void {
    this.program
      .name('visor')
      .description('Visor - AI-powered code review tool')
      .version(this.getVersion())
      .option(
        '-c, --check <type>',
        'Specify check type (can be used multiple times)',
        this.collectChecks,
        []
      )
      .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
      .option('--output-file <path>', 'Write formatted output to a file instead of stdout')
      .option('--config <path>', 'Path to configuration file')
      .option(
        '--timeout <ms>',
        'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)',
        value => parseInt(value, 10)
      )
      .option(
        '--max-parallelism <count>',
        'Maximum number of checks to run in parallel (default: 3)',
        value => parseInt(value, 10)
      )
      .option('--debug', 'Enable debug mode for detailed output')
      .option('-v, --verbose', 'Increase verbosity (without full debug)')
      .option('-q, --quiet', 'Reduce verbosity to warnings and errors')
      .option('--fail-fast', 'Stop execution on first failure condition')
      .option('--tags <tags>', 'Include checks with these tags (comma-separated)')
      .option('--exclude-tags <tags>', 'Exclude checks with these tags (comma-separated)')
      .option('--no-remote-extends', 'Disable loading configurations from remote URLs')
      .option('--enable-code-context', 'Force include code diffs in analysis (CLI mode)')
      .option('--disable-code-context', 'Force exclude code diffs from analysis (CLI mode)')
      .option(
        '--analyze-branch-diff',
        'Analyze diff vs base branch when on feature branch (auto-enabled for code-review schemas)'
      )
      .option(
        '--event <type>',
        'Simulate GitHub event (pr_opened, pr_updated, issue_opened, issue_comment, manual, all). Default: auto-detect from schema or "all"'
      )
      .option('--mode <mode>', 'Run mode (cli|github-actions). Default: cli')
      .addHelpText('after', this.getExamplesText())
      .exitOverride(); // Prevent automatic process.exit for better error handling

    // Add validation for options
    this.program.hook('preAction', thisCommand => {
      const opts = thisCommand.opts();
      this.validateOptions(opts);
    });
  }

  /**
   * Collect multiple check arguments
   */
  private collectChecks = (value: string, previous: string[]): string[] => {
    return previous.concat([value]);
  };

  /**
   * Parse command line arguments
   */
  public parseArgs(argv: string[]): CliOptions {
    try {
      // Ensure argv has at least the program name for commander.js
      const normalizedArgv =
        argv.length > 0 && !argv[0].startsWith('-') ? argv : ['node', 'visor', ...argv];

      // Create a fresh program instance for each parse to avoid state issues
      const tempProgram = new Command();
      tempProgram
        .name('visor')
        .description('Visor - AI-powered code review tool')
        .version(this.getVersion())
        .option(
          '-c, --check <type>',
          'Specify check type (can be used multiple times)',
          this.collectChecks,
          []
        )
        .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
        .option('--output-file <path>', 'Write formatted output to a file instead of stdout')
        .option('--config <path>', 'Path to configuration file')
        .option(
          '--timeout <ms>',
          'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)',
          value => parseInt(value, 10)
        )
        .option(
          '--max-parallelism <count>',
          'Maximum number of checks to run in parallel (default: 3)',
          value => parseInt(value, 10)
        )
        .option('--debug', 'Enable debug mode for detailed output')
        .option('-v, --verbose', 'Increase verbosity (without full debug)')
        .option('-q, --quiet', 'Reduce verbosity to warnings and errors')
        .option('--fail-fast', 'Stop execution on first failure condition')
        .option('--tags <tags>', 'Include checks with these tags (comma-separated)')
        .option('--exclude-tags <tags>', 'Exclude checks with these tags (comma-separated)')
        .option(
          '--allowed-remote-patterns <patterns>',
          'Comma-separated list of allowed URL prefixes for remote config extends (e.g., "https://github.com/,https://raw.githubusercontent.com/")'
        )
        .option('--enable-code-context', 'Force include code diffs in analysis (CLI mode)')
        .option('--disable-code-context', 'Force exclude code diffs from analysis (CLI mode)')
        .option(
          '--analyze-branch-diff',
          'Analyze diff vs base branch when on feature branch (auto-enabled for code-review schemas)'
        )
        .option(
          '--event <type>',
          'Simulate GitHub event (pr_opened, pr_updated, issue_opened, issue_comment, manual, all). Default: auto-detect from schema or "all"'
        )
        .option('--mode <mode>', 'Run mode (cli|github-actions). Default: cli')
        .allowUnknownOption(false)
        .allowExcessArguments(false) // Don't allow positional arguments
        .addHelpText('after', this.getExamplesText())
        .exitOverride(); // Prevent process.exit during tests

      tempProgram.parse(normalizedArgv);
      const options = tempProgram.opts();

      // Validate options
      this.validateOptions(options);

      // Remove duplicates and preserve order
      const uniqueChecks = [...new Set(options.check)] as CheckType[];

      // Set environment variable if no-remote-extends is set
      if (options.noRemoteExtends) {
        process.env.VISOR_NO_REMOTE_EXTENDS = 'true';
      }

      // Parse allowed remote patterns if provided
      let allowedRemotePatterns: string[] | undefined;
      if (options.allowedRemotePatterns) {
        allowedRemotePatterns = options.allowedRemotePatterns
          .split(',')
          .map((p: string) => p.trim());
      }

      // Parse tag filters
      let tags: string[] | undefined;
      if (options.tags) {
        tags = options.tags.split(',').map((t: string) => t.trim());
      }

      let excludeTags: string[] | undefined;
      if (options.excludeTags) {
        excludeTags = options.excludeTags.split(',').map((t: string) => t.trim());
      }

      // Determine code context mode
      let codeContext: 'auto' | 'enabled' | 'disabled' = 'auto';
      if (options.enableCodeContext) {
        codeContext = 'enabled';
      } else if (options.disableCodeContext) {
        codeContext = 'disabled';
      }

      return {
        checks: uniqueChecks,
        output: options.output as OutputFormat,
        outputFile: options.outputFile,
        configPath: options.config,
        timeout: options.timeout,
        maxParallelism: options.maxParallelism,
        debug: options.debug,
        verbose: options.verbose,
        quiet: options.quiet,
        failFast: options.failFast,
        tags,
        excludeTags,
        allowedRemotePatterns,
        help: options.help,
        version: options.version,
        codeContext,
      };
    } catch (error: unknown) {
      // Handle commander.js exit overrides for help/version ONLY
      if (error && typeof error === 'object' && 'code' in error) {
        const commanderError = error as { code: string };

        if (commanderError.code === 'commander.helpDisplayed') {
          return {
            checks: [],
            output: 'table' as OutputFormat,
            help: true,
          };
        }

        if (commanderError.code === 'commander.version') {
          return {
            checks: [],
            output: 'table' as OutputFormat,
            version: true,
          };
        }

        // For all other commander errors (including optionMissingArgument), re-throw
      }

      // Re-throw all errors including commander parsing errors
      throw error;
    }
  }

  /**
   * Validate parsed options
   */
  private validateOptions(options: Record<string, unknown>): void {
    // Skip check name validation here - it will be validated against the actual loaded config
    // This allows both built-in checks and config-defined checks to work properly

    // Validate output format
    if (options.output && !this.validOutputs.includes(options.output as OutputFormat)) {
      throw new Error(
        `Invalid output format: ${options.output}. Available options: ${this.validOutputs.join(', ')}`
      );
    }

    // Validate timeout
    if (options.timeout !== undefined) {
      if (typeof options.timeout !== 'number' || isNaN(options.timeout) || options.timeout < 0) {
        throw new Error(
          `Invalid timeout value: ${options.timeout}. Timeout must be a positive number in milliseconds.`
        );
      }
    }

    // Validate max parallelism
    if (options.maxParallelism !== undefined) {
      if (
        typeof options.maxParallelism !== 'number' ||
        isNaN(options.maxParallelism) ||
        options.maxParallelism < 1
      ) {
        throw new Error(
          `Invalid max parallelism value: ${options.maxParallelism}. Max parallelism must be a positive integer (minimum 1).`
        );
      }
    }
  }

  /**
   * Get help text
   */
  public getHelpText(): string {
    // Use the same configuration as parseArgs to ensure consistency
    const tempProgram = new Command();
    tempProgram
      .name('visor')
      .description('Visor - AI-powered code review tool')
      .version(this.getVersion())
      .option(
        '-c, --check <type>',
        'Specify check type (can be used multiple times)',
        this.collectChecks,
        []
      )
      .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
      .option('--output-file <path>', 'Write formatted output to a file instead of stdout')
      .option('--config <path>', 'Path to configuration file')
      .option(
        '--timeout <ms>',
        'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)',
        value => parseInt(value, 10)
      )
      .option(
        '--max-parallelism <count>',
        'Maximum number of checks to run in parallel (default: 3)',
        value => parseInt(value, 10)
      )
      .option('--debug', 'Enable debug mode for detailed output')
      .option('-v, --verbose', 'Increase verbosity (without full debug)')
      .option('-q, --quiet', 'Reduce verbosity to warnings and errors')
      .option('--fail-fast', 'Stop execution on first failure condition')
      .option('--tags <tags>', 'Include checks with these tags (comma-separated)')
      .option('--exclude-tags <tags>', 'Exclude checks with these tags (comma-separated)')
      .option('--enable-code-context', 'Force include code diffs in analysis (CLI mode)')
      .option('--disable-code-context', 'Force exclude code diffs from analysis (CLI mode)')
      .option(
        '--analyze-branch-diff',
        'Analyze diff vs base branch when on feature branch (auto-enabled for code-review schemas)'
      )
      .option('--mode <mode>', 'Run mode (cli|github-actions). Default: cli')
      .addHelpText('after', this.getExamplesText());

    // Get the basic help and append examples manually if addHelpText doesn't work
    const basicHelp = tempProgram.helpInformation();
    return basicHelp + this.getExamplesText();
  }

  /**
   * Get version from package.json
   */
  public getVersion(): string {
    // First, try environment variable (set during build/publish)
    if (process.env.VISOR_VERSION) {
      return process.env.VISOR_VERSION;
    }

    try {
      // Try multiple possible locations for package.json
      const possiblePaths = [
        path.join(__dirname, '../../package.json'), // Development
        path.join(__dirname, '../package.json'), // Alternate bundled
        path.join(process.cwd(), 'package.json'), // Current directory
        '/snapshot/visor/package.json', // Vercel pkg snapshot
      ];

      for (const packageJsonPath of possiblePaths) {
        if (fs.existsSync(packageJsonPath)) {
          try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            // Only use if it's the visor package
            if (packageJson.name === '@probelabs/visor' && packageJson.version) {
              return packageJson.version;
            }
          } catch {
            // Try next path
          }
        }
      }
    } catch {
      // Continue to fallback
    }

    // Fallback to the actual current version in package.json
    return '0.1.42';
  }

  /**
   * Get examples text for help
   */
  public getExamplesText(): string {
    return `
Examples:
  visor --check performance --output table
  visor --check performance --check security --config ./.visor.yaml
  visor --check all --output json
  visor --check architecture --check security --output markdown
  visor --check security --output sarif > results.sarif
  visor --check all --output json --output-file results.json   # Save to file reliably
  visor --check all --timeout 300000 --output json           # 5 minute timeout
  visor --check all --max-parallelism 5 --output json        # Run up to 5 checks in parallel
  visor --check all --debug --output markdown                # Enable debug mode
  visor --check all --fail-fast --output json                # Stop on first failure
  visor --tags local,fast --output table                      # Run checks tagged as 'local' or 'fast'
  visor --exclude-tags slow,experimental --output json        # Skip checks tagged as 'slow' or 'experimental'
  visor --tags security --exclude-tags slow                   # Run security checks but skip slow ones`;
  }

  /**
   * Display help
   */
  public showHelp(): void {
    this.program.help();
  }

  /**
   * Display version
   */
  public showVersion(): void {
    console.log(this.getVersion());
  }
}
