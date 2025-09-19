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
import { ConfigLoader, ConfigLoaderOptions } from './utils/config-loader';
import { ConfigMerger } from './utils/config-merger';

/**
 * Configuration manager for Visor
 */
export class ConfigManager {
  private validCheckTypes: ConfigCheckType[] = ['ai', 'tool', 'webhook', 'noop'];
  private validEventTriggers: EventTrigger[] = [
    'pr_opened',
    'pr_updated',
    'pr_closed',
    'issue_opened',
    'issue_comment',
    'manual',
  ];
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

      // Handle extends directive if present
      if (parsedConfig.extends) {
        const loaderOptions: ConfigLoaderOptions = {
          baseDir: path.dirname(configPath),
          allowRemote: this.isRemoteExtendsAllowed(),
          maxDepth: 10,
        };

        const loader = new ConfigLoader(loaderOptions);
        const merger = new ConfigMerger();

        // Process extends
        const extends_ = Array.isArray(parsedConfig.extends) ? parsedConfig.extends : [parsedConfig.extends];
        const { extends: _extendsField, ...configWithoutExtends } = parsedConfig;

        // Load and merge all parent configurations
        let mergedConfig: Partial<VisorConfig> = {};
        for (const source of extends_) {
          console.log(`📦 Extending from: ${source}`);
          const parentConfig = await loader.fetchConfig(source);
          mergedConfig = merger.merge(mergedConfig, parentConfig);
        }

        // Merge with current config (child overrides parent)
        parsedConfig = merger.merge(mergedConfig, configWithoutExtends);

        // Remove disabled checks (those with empty 'on' array)
        parsedConfig = merger.removeDisabledChecks(parsedConfig);
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

    // Try to load bundled default config
    const bundledConfig = this.loadBundledDefaultConfig();
    if (bundledConfig) {
      return bundledConfig;
    }

    // Return minimal default config if no bundled config found
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
      max_parallelism: 3,
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
   * Load bundled default configuration from the package
   */
  public loadBundledDefaultConfig(): VisorConfig | null {
    try {
      // Find the package root by looking for package.json
      const packageRoot = this.findPackageRoot();
      if (!packageRoot) {
        return null;
      }

      const bundledConfigPath = path.join(packageRoot, 'defaults', '.visor.yaml');
      if (fs.existsSync(bundledConfigPath)) {
        const configContent = fs.readFileSync(bundledConfigPath, 'utf8');
        const parsedConfig = yaml.load(configContent) as Partial<VisorConfig>;

        if (!parsedConfig || typeof parsedConfig !== 'object') {
          return null;
        }

        // Validate and merge with defaults
        this.validateConfig(parsedConfig);
        return this.mergeWithDefaults(parsedConfig) as VisorConfig;
      }
    } catch (error) {
      // Silently fail and return null - will fall back to minimal default
      console.warn(
        'Failed to load bundled default config:',
        error instanceof Error ? error.message : String(error)
      );
    }

    return null;
  }

  /**
   * Find the root directory of the Visor package
   */
  private findPackageRoot(): string | null {
    let currentDir = __dirname;

    // Walk up the directory tree to find package.json
    while (currentDir !== path.dirname(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          // Check if this is the Visor package
          if (packageJson.name === '@probelabs/visor') {
            return currentDir;
          }
        } catch {
          // Continue searching if package.json is invalid
        }
      }
      currentDir = path.dirname(currentDir);
    }

    return null;
  }

  /**
   * Merge configuration with CLI options
   */
  public mergeWithCliOptions(config: Partial<VisorConfig>, cliOptions: CliOptions): MergedConfig {
    // Apply CLI overrides to the config
    const mergedConfig = { ...config };

    // Override max_parallelism if specified in CLI
    if (cliOptions.maxParallelism !== undefined) {
      mergedConfig.max_parallelism = cliOptions.maxParallelism;
    }

    // Override fail_fast if specified in CLI
    if (cliOptions.failFast !== undefined) {
      mergedConfig.fail_fast = cliOptions.failFast;
    }

    return {
      config: mergedConfig,
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

    // Validate max_parallelism if present
    if (config.max_parallelism !== undefined) {
      if (
        typeof config.max_parallelism !== 'number' ||
        config.max_parallelism < 1 ||
        !Number.isInteger(config.max_parallelism)
      ) {
        errors.push({
          field: 'max_parallelism',
          message: 'max_parallelism must be a positive integer (minimum 1)',
          value: config.max_parallelism,
        });
      }
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

    // Only AI checks require prompts
    if (checkConfig.type === 'ai' && !checkConfig.prompt) {
      errors.push({
        field: `checks.${checkName}.prompt`,
        message: `Invalid check configuration for "${checkName}": missing prompt (required for AI checks)`,
      });
    }

    // Tool checks require exec field
    if (checkConfig.type === 'tool' && !checkConfig.exec) {
      errors.push({
        field: `checks.${checkName}.exec`,
        message: `Invalid check configuration for "${checkName}": missing exec field (required for tool checks)`,
      });
    }

    // Webhook checks require url field
    if (checkConfig.type === 'webhook' && !checkConfig.url) {
      errors.push({
        field: `checks.${checkName}.url`,
        message: `Invalid check configuration for "${checkName}": missing url field (required for webhook checks)`,
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

    // Validate reuse_ai_session configuration
    if (checkConfig.reuse_ai_session !== undefined) {
      if (typeof checkConfig.reuse_ai_session !== 'boolean') {
        errors.push({
          field: `checks.${checkName}.reuse_ai_session`,
          message: `Invalid reuse_ai_session value for "${checkName}": must be boolean`,
          value: checkConfig.reuse_ai_session,
        });
      } else if (checkConfig.reuse_ai_session === true) {
        // When reuse_ai_session is true, depends_on must be specified and non-empty
        if (
          !checkConfig.depends_on ||
          !Array.isArray(checkConfig.depends_on) ||
          checkConfig.depends_on.length === 0
        ) {
          errors.push({
            field: `checks.${checkName}.reuse_ai_session`,
            message: `Check "${checkName}" has reuse_ai_session=true but missing or empty depends_on. Session reuse requires dependency on another check.`,
            value: checkConfig.reuse_ai_session,
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
   * Check if remote extends are allowed
   */
  private isRemoteExtendsAllowed(): boolean {
    // Check environment variable first
    if (process.env.VISOR_NO_REMOTE_EXTENDS === 'true' || process.env.VISOR_NO_REMOTE_EXTENDS === '1') {
      return false;
    }
    // Default to allowing remote extends
    return true;
  }

  /**
   * Merge configuration with default values
   */
  private mergeWithDefaults(config: Partial<VisorConfig>): Partial<VisorConfig> {
    const defaultConfig = {
      version: '1.0',
      checks: {},
      max_parallelism: 3,
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
