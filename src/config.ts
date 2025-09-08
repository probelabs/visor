import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import {
  VisorConfig,
  CheckConfig,
  ConfigCheckType,
  EventTrigger,
  ConfigOutputFormat,
  GroupByOption,
  ConfigValidationError,
  EnvironmentOverrides,
  MergedConfig,
  ConfigLoadOptions,
} from './types/config';
import { CliOptions } from './types/cli';

/**
 * Configuration manager for Visor
 */
export class ConfigManager {
  private validCheckTypes: ConfigCheckType[] = ['ai'];
  private validEventTriggers: EventTrigger[] = ['pr_opened', 'pr_updated', 'pr_closed'];
  private validOutputFormats: ConfigOutputFormat[] = ['table', 'json', 'markdown', 'sarif'];
  private validGroupByOptions: GroupByOption[] = ['check', 'file', 'severity'];

  /**
   * Load configuration from a file
   */
  public async loadConfig(
    configPath: string,
    options: ConfigLoadOptions = {}
  ): Promise<VisorConfig> {
    const { validate = true, mergeDefaults = true } = options;

    try {
      if (!fs.existsSync(configPath)) {
        throw new Error(`Configuration file not found: ${configPath}`);
      }

      const configContent = fs.readFileSync(configPath, 'utf8');
      let parsedConfig: Partial<VisorConfig>;

      try {
        parsedConfig = yaml.load(configContent) as Partial<VisorConfig>;
      } catch (yamlError) {
        const errorMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
        throw new Error(`Invalid YAML syntax in ${configPath}: ${errorMessage}`);
      }

      if (!parsedConfig || typeof parsedConfig !== 'object') {
        throw new Error('Configuration file must contain a valid YAML object');
      }

      if (validate) {
        this.validateConfig(parsedConfig);
      }

      let finalConfig = parsedConfig;
      if (mergeDefaults) {
        finalConfig = this.mergeWithDefaults(parsedConfig);
      }

      return finalConfig as VisorConfig;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found') || error.message.includes('Invalid YAML')) {
          throw error;
        }
        throw new Error(`Failed to read configuration file: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Find and load configuration from default locations
   */
  public async findAndLoadConfig(): Promise<VisorConfig> {
    // Try to find the git repository root first, fall back to current directory
    const gitRoot = await this.findGitRepositoryRoot();
    const searchDirs = [gitRoot, process.cwd()].filter(Boolean) as string[];

    for (const baseDir of searchDirs) {
      const possiblePaths = [path.join(baseDir, '.visor.yaml'), path.join(baseDir, '.visor.yml')];

      for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
          return this.loadConfig(configPath);
        }
      }
    }

    // Return default config if no file found
    return this.getDefaultConfig();
  }

  /**
   * Find the git repository root directory
   */
  private async findGitRepositoryRoot(): Promise<string | null> {
    try {
      const git = simpleGit();
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return null;
      }

      // Get the repository root directory
      const rootDir = await git.revparse(['--show-toplevel']);
      return rootDir.trim();
    } catch {
      // Not in a git repository or git not available
      return null;
    }
  }

  /**
   * Get default configuration
   */
  public async getDefaultConfig(): Promise<VisorConfig> {
    return {
      version: '1.0',
      checks: {},
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: true,
        },
      },
    };
  }

  /**
   * Merge configuration with CLI options
   */
  public mergeWithCliOptions(config: Partial<VisorConfig>, cliOptions: CliOptions): MergedConfig {
    return {
      config,
      cliChecks: cliOptions.checks || [],
      cliOutput: cliOptions.output || 'table',
    };
  }

  /**
   * Load configuration with environment variable overrides
   */
  public async loadConfigWithEnvOverrides(): Promise<{
    config?: VisorConfig;
    environmentOverrides: EnvironmentOverrides;
  }> {
    const environmentOverrides: EnvironmentOverrides = {};

    // Check for environment variable overrides
    if (process.env.VISOR_CONFIG_PATH) {
      environmentOverrides.configPath = process.env.VISOR_CONFIG_PATH;
    }
    if (process.env.VISOR_OUTPUT_FORMAT) {
      environmentOverrides.outputFormat = process.env.VISOR_OUTPUT_FORMAT;
    }

    let config: VisorConfig | undefined;

    if (environmentOverrides.configPath) {
      try {
        config = await this.loadConfig(environmentOverrides.configPath);
      } catch {
        // If environment config fails, fall back to default discovery
        config = await this.findAndLoadConfig();
      }
    } else {
      config = await this.findAndLoadConfig();
    }

    return { config, environmentOverrides };
  }

  /**
   * Validate configuration against schema
   */
  private validateConfig(config: Partial<VisorConfig>): void {
    const errors: ConfigValidationError[] = [];

    // Validate required fields
    if (!config.version) {
      errors.push({
        field: 'version',
        message: 'Missing required field: version',
      });
    }

    if (!config.checks) {
      errors.push({
        field: 'checks',
        message: 'Missing required field: checks',
      });
    } else {
      // Validate each check configuration
      for (const [checkName, checkConfig] of Object.entries(config.checks)) {
        this.validateCheckConfig(checkName, checkConfig, errors);
      }
    }

    // Validate output configuration if present
    if (config.output) {
      this.validateOutputConfig(config.output as unknown as Record<string, unknown>, errors);
    }

    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
  }

  /**
   * Validate individual check configuration
   */
  private validateCheckConfig(
    checkName: string,
    checkConfig: CheckConfig,
    errors: ConfigValidationError[]
  ): void {
    if (!checkConfig.type) {
      errors.push({
        field: `checks.${checkName}.type`,
        message: `Invalid check configuration for "${checkName}": missing type`,
      });
      return;
    }

    if (!this.validCheckTypes.includes(checkConfig.type)) {
      errors.push({
        field: `checks.${checkName}.type`,
        message: `Invalid check type "${checkConfig.type}". Must be: ${this.validCheckTypes.join(', ')}`,
        value: checkConfig.type,
      });
    }

    if (!checkConfig.prompt) {
      errors.push({
        field: `checks.${checkName}.prompt`,
        message: `Invalid check configuration for "${checkName}": missing prompt`,
      });
    }

    if (!checkConfig.on || !Array.isArray(checkConfig.on)) {
      errors.push({
        field: `checks.${checkName}.on`,
        message: `Invalid check configuration for "${checkName}": missing or invalid 'on' field`,
      });
    } else {
      // Validate event triggers
      for (const event of checkConfig.on) {
        if (!this.validEventTriggers.includes(event)) {
          errors.push({
            field: `checks.${checkName}.on`,
            message: `Invalid event "${event}". Must be one of: ${this.validEventTriggers.join(', ')}`,
            value: event,
          });
        }
      }
    }
  }

  /**
   * Validate output configuration
   */
  private validateOutputConfig(
    outputConfig: Record<string, unknown>,
    errors: ConfigValidationError[]
  ): void {
    if (outputConfig.pr_comment) {
      const prComment = outputConfig.pr_comment as Record<string, unknown>;

      if (
        typeof prComment.format === 'string' &&
        !this.validOutputFormats.includes(prComment.format as ConfigOutputFormat)
      ) {
        errors.push({
          field: 'output.pr_comment.format',
          message: `Invalid output format "${prComment.format}". Must be one of: ${this.validOutputFormats.join(', ')}`,
          value: prComment.format as string,
        });
      }

      if (
        typeof prComment.group_by === 'string' &&
        !this.validGroupByOptions.includes(prComment.group_by as GroupByOption)
      ) {
        errors.push({
          field: 'output.pr_comment.group_by',
          message: `Invalid group_by option "${prComment.group_by}". Must be one of: ${this.validGroupByOptions.join(', ')}`,
          value: prComment.group_by as string,
        });
      }
    }
  }

  /**
   * Merge configuration with default values
   */
  private mergeWithDefaults(config: Partial<VisorConfig>): Partial<VisorConfig> {
    const defaultConfig = {
      version: '1.0',
      checks: {},
      output: {
        pr_comment: {
          format: 'markdown' as ConfigOutputFormat,
          group_by: 'check' as GroupByOption,
          collapse: true,
        },
      },
    };

    // Deep merge with defaults
    const merged = { ...defaultConfig, ...config };

    // Ensure output has default values
    if (merged.output) {
      merged.output.pr_comment = {
        ...defaultConfig.output.pr_comment,
        ...merged.output.pr_comment,
      };
    } else {
      merged.output = defaultConfig.output;
    }

    return merged;
  }
}
