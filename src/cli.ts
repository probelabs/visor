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
      .option('--fail-fast', 'Stop execution on first failure condition')
      .option('--no-remote-extends', 'Disable loading configurations from remote URLs')
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
        .option('--fail-fast', 'Stop execution on first failure condition')
        .option(
          '--allowed-remote-patterns <patterns>',
          'Comma-separated list of allowed URL prefixes for remote config extends (e.g., "https://github.com/,https://raw.githubusercontent.com/")'
        )
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

      return {
        checks: uniqueChecks,
        output: options.output as OutputFormat,
        configPath: options.config,
        timeout: options.timeout,
        maxParallelism: options.maxParallelism,
        debug: options.debug,
        failFast: options.failFast,
        allowedRemotePatterns,
        help: options.help,
        version: options.version,
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
      .option('--fail-fast', 'Stop execution on first failure condition')
      .addHelpText('after', this.getExamplesText());

    // Get the basic help and append examples manually if addHelpText doesn't work
    const basicHelp = tempProgram.helpInformation();
    return basicHelp + this.getExamplesText();
  }

  /**
   * Get version from package.json
   */
  public getVersion(): string {
    try {
      const packageJsonPath = path.join(__dirname, '../../package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || '1.0.0';
      }
    } catch {
      // Fallback to default version
    }
    return '1.0.0';
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
  visor --check all --timeout 300000 --output json           # 5 minute timeout
  visor --check all --max-parallelism 5 --output json        # Run up to 5 checks in parallel
  visor --check all --debug --output markdown                # Enable debug mode
  visor --check all --fail-fast --output json                # Stop on first failure`;
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
