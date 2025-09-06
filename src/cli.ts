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
      .option('--debug', 'Enable debug mode for detailed output')
      .addHelpText('after', this.getExamplesText());

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
        .option('--debug', 'Enable debug mode for detailed output')
        .allowUnknownOption(false)
        .allowExcessArguments(false) // Don't allow positional arguments
        .addHelpText('after', this.getExamplesText())
        .exitOverride(); // Prevent process.exit during tests

      tempProgram.parse(argv, { from: 'user' });
      const options = tempProgram.opts();

      // Validate options
      this.validateOptions(options);

      // Remove duplicates and preserve order
      const uniqueChecks = [...new Set(options.check)] as CheckType[];

      return {
        checks: uniqueChecks,
        output: options.output as OutputFormat,
        configPath: options.config,
        timeout: options.timeout,
        debug: options.debug,
        help: options.help,
        version: options.version,
      };
    } catch (error) {
      if (error instanceof Error) {
        // Handle commander.js specific errors
        if (error.message.includes('unknown option') || error.message.includes('Unknown option')) {
          throw error;
        }
        if (
          error.message.includes('Missing required argument') ||
          error.message.includes('argument missing')
        ) {
          throw error;
        }
        if (error.message.includes('too many arguments')) {
          throw error;
        }
        throw new Error(`CLI parsing error: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Validate parsed options
   */
  private validateOptions(options: Record<string, unknown>): void {
    // Validate check types
    if (Array.isArray(options.check) && options.check.length > 0) {
      for (const check of options.check) {
        if (!this.validChecks.includes(check as CheckType)) {
          throw new Error(
            `Invalid check type: ${check}. Available options: ${this.validChecks.join(', ')}`
          );
        }
      }
    }

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
      .option('--debug', 'Enable debug mode for detailed output')
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
  visor --check performance --check security --config ./visor.config.yaml
  visor --check all --output json
  visor --check architecture --check security --output markdown
  visor --check security --output sarif > results.sarif
  visor --check all --timeout 300000 --output json   # 5 minute timeout
  visor --check all --debug --output markdown        # Enable debug mode`;
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
