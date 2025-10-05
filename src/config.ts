import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
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
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

/**
 * Configuration manager for Visor
 */
export class ConfigManager {
  private validCheckTypes: ConfigCheckType[] = [
    'ai',
    'claude-code',
    'command',
    'http',
    'http_input',
    'http_client',
    'noop',
    'log',
  ];
  private validEventTriggers: EventTrigger[] = [
    'pr_opened',
    'pr_updated',
    'pr_closed',
    'issue_opened',
    'issue_comment',
    'manual',
    'schedule',
    'webhook_received',
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
    const { validate = true, mergeDefaults = true, allowedRemotePatterns } = options;

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
          allowedRemotePatterns,
        };

        const loader = new ConfigLoader(loaderOptions);
        const merger = new ConfigMerger();

        // Process extends
        const extends_ = Array.isArray(parsedConfig.extends)
          ? parsedConfig.extends
          : [parsedConfig.extends];
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
        // Pass through detailed error messages unchanged
        if (
          error.message.includes('not found') ||
          error.message.includes('Invalid YAML') ||
          error.message.includes('extends') ||
          error.message.includes('EACCES') ||
          error.message.includes('EISDIR')
        ) {
          throw error;
        }
        // Add more context for generic errors
        if (error.message.includes('ENOENT')) {
          throw new Error(`Configuration file not found: ${configPath}`);
        }
        if (error.message.includes('EPERM')) {
          throw new Error(`Permission denied reading configuration file: ${configPath}`);
        }
        throw new Error(`Failed to read configuration file ${configPath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Find and load configuration from default locations
   */
  public async findAndLoadConfig(options: ConfigLoadOptions = {}): Promise<VisorConfig> {
    // Try to find the git repository root first, fall back to current directory
    const gitRoot = await this.findGitRepositoryRoot();
    const searchDirs = [gitRoot, process.cwd()].filter(Boolean) as string[];

    for (const baseDir of searchDirs) {
      const possiblePaths = [path.join(baseDir, '.visor.yaml'), path.join(baseDir, '.visor.yml')];

      for (const configPath of possiblePaths) {
        if (fs.existsSync(configPath)) {
          return this.loadConfig(configPath, options);
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
      // Try different paths to find the bundled default config (support CJS and ESM)
      const possiblePaths: string[] = [];

      // __dirname is available in CJS; guard for ESM builds
      if (typeof __dirname !== 'undefined') {
        possiblePaths.push(
          path.join(__dirname, 'defaults', '.visor.yaml'),
          path.join(__dirname, '..', 'defaults', '.visor.yaml')
        );
      }

      // Try via package root
      const pkgRoot = this.findPackageRoot();
      if (pkgRoot) {
        possiblePaths.push(path.join(pkgRoot, 'defaults', '.visor.yaml'));
      }

      // GitHub Action environment variable
      if (process.env.GITHUB_ACTION_PATH) {
        possiblePaths.push(
          path.join(process.env.GITHUB_ACTION_PATH, 'defaults', '.visor.yaml'),
          path.join(process.env.GITHUB_ACTION_PATH, 'dist', 'defaults', '.visor.yaml')
        );
      }

      let bundledConfigPath: string | undefined;
      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          bundledConfigPath = possiblePath;
          break;
        }
      }

      if (bundledConfigPath && fs.existsSync(bundledConfigPath)) {
        // Always log to stderr to avoid contaminating formatted output
        console.error(`📦 Loading bundled default configuration from ${bundledConfigPath}`);
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
    const warnings: ConfigValidationError[] = [];

    // First, run schema-based validation (runtime-generated).
    // Unknown keys become schema errors (we convert additionalProperties to warnings by default).
    this.validateWithAjvSchema(config, errors, warnings);

    // Validate required fields
    if (!config.version) {
      errors.push({
        field: 'version',
        message: 'Missing required field: version',
      });
    }

    // Also run lightweight manual unknown-key warnings to catch typos consistently.
    this.warnUnknownRootKeys(config, warnings);

    if (!config.checks) {
      errors.push({
        field: 'checks',
        message: 'Missing required field: checks',
      });
    } else {
      // Validate each check configuration
      for (const [checkName, checkConfig] of Object.entries(config.checks)) {
        // Default type to 'ai' if not specified
        if (!checkConfig.type) {
          checkConfig.type = 'ai';
        }
        // 'on' field is optional - if not specified, check can run on any event
        this.validateCheckConfig(checkName, checkConfig, errors);

        // Warn on unknown/typo keys at the check level
        this.warnUnknownCheckKeys(checkName, checkConfig as Record<string, unknown>, warnings);

        // Validate MCP servers at check-level (basic shape only)
        if (checkConfig.ai_mcp_servers) {
          this.validateMcpServersObject(
            checkConfig.ai_mcp_servers,
            `checks.${checkName}.ai_mcp_servers`,
            errors,
            warnings
          );
        }
        if ((checkConfig as CheckConfig).ai?.mcpServers) {
          this.validateMcpServersObject(
            (checkConfig as CheckConfig).ai!.mcpServers as Record<string, unknown>,
            `checks.${checkName}.ai.mcpServers`,
            errors,
            warnings
          );
        }
        // 3) Precedence warning if both are provided
        if (checkConfig.ai_mcp_servers && (checkConfig as CheckConfig).ai?.mcpServers) {
          const lower = Object.keys(checkConfig.ai_mcp_servers);
          const higher = Object.keys((checkConfig as CheckConfig).ai!.mcpServers!);
          const overridden = lower.filter(k => higher.includes(k));
          warnings.push({
            field: `checks.${checkName}.ai.mcpServers`,
            message:
              overridden.length > 0
                ? `Both ai_mcp_servers and ai.mcpServers are set; ai.mcpServers overrides these servers: ${overridden.join(
                    ', '
                  )}`
                : 'Both ai_mcp_servers and ai.mcpServers are set; ai.mcpServers takes precedence for this check.',
          });
        }
      }
    }

    // Validate global MCP servers if present
    if (config.ai_mcp_servers) {
      this.validateMcpServersObject(config.ai_mcp_servers, 'ai_mcp_servers', errors, warnings);
    }

    // Validate output configuration if present
    if (config.output) {
      this.validateOutputConfig(config.output as unknown as Record<string, unknown>, errors);
    }

    // Validate HTTP server configuration if present
    if (config.http_server) {
      this.validateHttpServerConfig(
        config.http_server as unknown as Record<string, unknown>,
        errors
      );
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

    // Validate tag_filter if present
    if (config.tag_filter) {
      this.validateTagFilter(config.tag_filter as unknown as Record<string, unknown>, errors);
    }

    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }
    // Emit warnings (do not block execution)
    if (warnings.length > 0) {
      for (const w of warnings) {
        logger.warn(`⚠️  Config warning [${w.field}]: ${w.message}`);
      }
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
    // Default to 'ai' if no type specified
    if (!checkConfig.type) {
      checkConfig.type = 'ai';
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

    // Command checks require exec field
    if (checkConfig.type === 'command' && !checkConfig.exec) {
      errors.push({
        field: `checks.${checkName}.exec`,
        message: `Invalid check configuration for "${checkName}": missing exec field (required for command checks)`,
      });
    }

    // HTTP output checks require url and body fields
    if (checkConfig.type === 'http') {
      if (!checkConfig.url) {
        errors.push({
          field: `checks.${checkName}.url`,
          message: `Invalid check configuration for "${checkName}": missing url field (required for http checks)`,
        });
      }
      if (!checkConfig.body) {
        errors.push({
          field: `checks.${checkName}.body`,
          message: `Invalid check configuration for "${checkName}": missing body field (required for http checks)`,
        });
      }
    }

    // HTTP input checks require endpoint field
    if (checkConfig.type === 'http_input' && !checkConfig.endpoint) {
      errors.push({
        field: `checks.${checkName}.endpoint`,
        message: `Invalid check configuration for "${checkName}": missing endpoint field (required for http_input checks)`,
      });
    }

    // HTTP client checks require url field
    if (checkConfig.type === 'http_client' && !checkConfig.url) {
      errors.push({
        field: `checks.${checkName}.url`,
        message: `Invalid check configuration for "${checkName}": missing url field (required for http_client checks)`,
      });
    }

    // Validate cron schedule if specified
    if (checkConfig.schedule) {
      // Basic cron validation - could use node-cron.validate() for better validation
      const cronParts = checkConfig.schedule.split(' ');
      if (cronParts.length < 5 || cronParts.length > 6) {
        errors.push({
          field: `checks.${checkName}.schedule`,
          message: `Invalid cron expression for "${checkName}": ${checkConfig.schedule}`,
          value: checkConfig.schedule,
        });
      }
    }

    // 'on' field is optional - if not specified, check can be triggered by any event
    if (checkConfig.on) {
      if (!Array.isArray(checkConfig.on)) {
        errors.push({
          field: `checks.${checkName}.on`,
          message: `Invalid check configuration for "${checkName}": 'on' field must be an array`,
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

    // Validate tags configuration
    if (checkConfig.tags !== undefined) {
      if (!Array.isArray(checkConfig.tags)) {
        errors.push({
          field: `checks.${checkName}.tags`,
          message: `Invalid tags value for "${checkName}": must be an array of strings`,
          value: checkConfig.tags,
        });
      } else {
        // Validate each tag
        const validTagPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;
        checkConfig.tags.forEach((tag, index) => {
          if (typeof tag !== 'string') {
            errors.push({
              field: `checks.${checkName}.tags[${index}]`,
              message: `Invalid tag at index ${index} for "${checkName}": must be a string`,
              value: tag,
            });
          } else if (!validTagPattern.test(tag)) {
            errors.push({
              field: `checks.${checkName}.tags[${index}]`,
              message: `Invalid tag "${tag}" for "${checkName}": tags must be alphanumeric with hyphens or underscores (start with alphanumeric)`,
              value: tag,
            });
          }
        });
      }
    }
  }

  /**
   * Validate MCP servers object shape and values (basic shape only)
   */
  private validateMcpServersObject(
    mcpServers: unknown,
    fieldPrefix: string,
    errors: ConfigValidationError[],
    _warnings: ConfigValidationError[]
  ): void {
    if (typeof mcpServers !== 'object' || mcpServers === null) {
      errors.push({
        field: fieldPrefix,
        message: `${fieldPrefix} must be an object mapping server names to { command, args?, env? }`,
        value: mcpServers,
      });
      return;
    }

    for (const [serverName, cfg] of Object.entries(mcpServers as Record<string, unknown>)) {
      const pathStr = `${fieldPrefix}.${serverName}`;
      if (!cfg || typeof cfg !== 'object') {
        errors.push({ field: pathStr, message: `${pathStr} must be an object`, value: cfg });
        continue;
      }
      const { command, args, env } = cfg as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof command !== 'string' || command.trim() === '') {
        errors.push({
          field: `${pathStr}.command`,
          message: `${pathStr}.command must be a non-empty string`,
          value: command,
        });
      }
      if (args !== undefined && !Array.isArray(args)) {
        errors.push({
          field: `${pathStr}.args`,
          message: `${pathStr}.args must be an array of strings`,
          value: args,
        });
      }
      if (env !== undefined) {
        if (typeof env !== 'object' || env === null) {
          errors.push({
            field: `${pathStr}.env`,
            message: `${pathStr}.env must be an object of string values`,
            value: env,
          });
        } else {
          for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
            if (typeof v !== 'string') {
              errors.push({
                field: `${pathStr}.env.${k}`,
                message: `${pathStr}.env.${k} must be a string`,
                value: v,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Validate configuration using generated JSON Schema via Ajv, if available.
   * Adds to errors/warnings but does not throw directly.
   */
  private validateWithAjvSchema(
    config: Partial<VisorConfig>,
    errors: ConfigValidationError[],
    warnings: ConfigValidationError[]
  ): void {
    try {
      if (!__ajvValidate) {
        __scheduleAjvBuild();
        return; // use manual validators for this call; Ajv will be ready shortly
      }

      const ok = __ajvValidate(config);
      const errs = __ajvErrors ? __ajvErrors() : null;
      if (!ok && Array.isArray(errs)) {
        for (const e of errs) {
          const pathStr = e.instancePath
            ? e.instancePath.replace(/^\//, '').replace(/\//g, '.')
            : '';
          const msg = e.message || 'Invalid configuration';
          if (e.keyword === 'additionalProperties') {
            const addl = (e.params && (e.params as any).additionalProperty) || 'unknown';
            const fullField = pathStr ? `${pathStr}.${addl}` : addl;
            const topLevel = !pathStr;
            warnings.push({
              field: fullField || 'config',
              message: topLevel
                ? `Unknown top-level key '${addl}' will be ignored.`
                : `Unknown key '${addl}' will be ignored`,
            });
          } else {
            errors.push({ field: pathStr || 'config', message: msg });
          }
        }
      }
    } catch (err) {
      logger.debug(`Ajv validation skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Warn about unknown root-level keys to catch typos/non-existing options
   */
  private warnUnknownRootKeys(
    config: Partial<VisorConfig>,
    warnings: ConfigValidationError[]
  ): void {
    const allowed: Set<string> = new Set([
      'version',
      'extends',
      'checks',
      'output',
      'http_server',
      'env',
      'ai_model',
      'ai_provider',
      'ai_mcp_servers',
      'max_parallelism',
      'fail_fast',
      'fail_if',
      'failure_conditions',
      'tag_filter',
      'routing',
    ]);
    for (const key of Object.keys(config)) {
      if (!allowed.has(key)) {
        warnings.push({ field: key, message: `Unknown top-level key '${key}' will be ignored.` });
      }
    }
  }

  /**
   * Warn about unknown keys at check-level and inside nested ai/claude_code objects
   */
  private warnUnknownCheckKeys(
    checkName: string,
    checkConfig: Record<string, unknown>,
    warnings: ConfigValidationError[]
  ): void {
    const allowedCheckKeys = new Set([
      // common
      'type',
      'prompt',
      'appendPrompt',
      'exec',
      'stdin',
      'url',
      'body',
      'method',
      'headers',
      'endpoint',
      'transform',
      'transform_js',
      'schedule',
      'focus',
      'command',
      'on',
      'triggers',
      'ai',
      'ai_model',
      'ai_provider',
      'ai_mcp_servers',
      'claude_code',
      'env',
      'depends_on',
      'group',
      'schema',
      'template',
      'if',
      'reuse_ai_session',
      'fail_if',
      'failure_conditions',
      'tags',
      'forEach',
      'on_fail',
      'on_success',
      // rarely used / internal-friendly
      'eventContext',
      'workingDirectory',
      'timeout',
      'metadata',
      'sessionId',
      // deprecated alias we warn about explicitly
      'args',
    ]);

    // Check-level unknown keys
    for (const key of Object.keys(checkConfig)) {
      if (!allowedCheckKeys.has(key)) {
        warnings.push({
          field: `checks.${checkName}.${key}`,
          message: `Unknown key '${key}' in check '${checkName}' will be ignored`,
        });
      }
    }

    // Deprecation notice
    if (Object.prototype.hasOwnProperty.call(checkConfig, 'args')) {
      warnings.push({
        field: `checks.${checkName}.args`,
        message: `Deprecated key 'args' in checks.${checkName}. Use 'exec' with inline args instead.`,
      });
    }

    // ai.* unknown keys
    const ai = checkConfig['ai'];
    if (ai && typeof ai === 'object') {
      const allowedAIKeys = new Set([
        'provider',
        'model',
        'apiKey',
        'timeout',
        'debug',
        'mcpServers',
      ]);
      for (const key of Object.keys(ai as Record<string, unknown>)) {
        if (!allowedAIKeys.has(key)) {
          warnings.push({
            field: `checks.${checkName}.ai.${key}`,
            message: `Unknown key '${key}' under ai; valid: ${Array.from(allowedAIKeys).join(', ')}`,
          });
        }
      }
    }

    // claude_code.* unknown keys
    const cc = checkConfig['claude_code'];
    if (cc && typeof cc === 'object') {
      const allowedCC = new Set([
        'allowedTools',
        'maxTurns',
        'systemPrompt',
        'mcpServers',
        'subagent',
        'hooks',
      ]);
      for (const key of Object.keys(cc as Record<string, unknown>)) {
        if (!allowedCC.has(key)) {
          warnings.push({
            field: `checks.${checkName}.claude_code.${key}`,
            message: `Unknown key '${key}' under claude_code will be ignored`,
          });
        }
      }
      // hooks subkeys
      const hooks = (cc as Record<string, unknown>)['hooks'];
      if (hooks && typeof hooks === 'object') {
        const allowedHooks = new Set(['onStart', 'onEnd', 'onError']);
        for (const key of Object.keys(hooks as Record<string, unknown>)) {
          if (!allowedHooks.has(key)) {
            warnings.push({
              field: `checks.${checkName}.claude_code.hooks.${key}`,
              message: `Unknown key '${key}' in hooks will be ignored`,
            });
          }
        }
      }
    }
  }
  // Unknown-key hints are produced by Ajv (additionalProperties=false)

  /**
   * Validate tag filter configuration
   */
  private validateTagFilter(
    tagFilter: Record<string, unknown>,
    errors: ConfigValidationError[]
  ): void {
    const validTagPattern = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

    // Validate include tags
    if (tagFilter.include !== undefined) {
      if (!Array.isArray(tagFilter.include)) {
        errors.push({
          field: 'tag_filter.include',
          message: 'tag_filter.include must be an array of strings',
          value: tagFilter.include,
        });
      } else {
        tagFilter.include.forEach((tag: unknown, index: number) => {
          if (typeof tag !== 'string') {
            errors.push({
              field: `tag_filter.include[${index}]`,
              message: `Invalid tag at index ${index}: must be a string`,
              value: tag,
            });
          } else if (!validTagPattern.test(tag as string)) {
            errors.push({
              field: `tag_filter.include[${index}]`,
              message: `Invalid tag "${tag}": tags must be alphanumeric with hyphens or underscores`,
              value: tag,
            });
          }
        });
      }
    }

    // Validate exclude tags
    if (tagFilter.exclude !== undefined) {
      if (!Array.isArray(tagFilter.exclude)) {
        errors.push({
          field: 'tag_filter.exclude',
          message: 'tag_filter.exclude must be an array of strings',
          value: tagFilter.exclude,
        });
      } else {
        tagFilter.exclude.forEach((tag: unknown, index: number) => {
          if (typeof tag !== 'string') {
            errors.push({
              field: `tag_filter.exclude[${index}]`,
              message: `Invalid tag at index ${index}: must be a string`,
              value: tag,
            });
          } else if (!validTagPattern.test(tag as string)) {
            errors.push({
              field: `tag_filter.exclude[${index}]`,
              message: `Invalid tag "${tag}": tags must be alphanumeric with hyphens or underscores`,
              value: tag,
            });
          }
        });
      }
    }
  }

  /**
   * Validate HTTP server configuration
   */
  private validateHttpServerConfig(
    httpServerConfig: Record<string, unknown>,
    errors: ConfigValidationError[]
  ): void {
    if (typeof httpServerConfig.enabled !== 'boolean') {
      errors.push({
        field: 'http_server.enabled',
        message: 'http_server.enabled must be a boolean',
        value: httpServerConfig.enabled,
      });
    }

    if (httpServerConfig.enabled === true) {
      // Port is required when enabled
      if (
        typeof httpServerConfig.port !== 'number' ||
        httpServerConfig.port < 1 ||
        httpServerConfig.port > 65535
      ) {
        errors.push({
          field: 'http_server.port',
          message: 'http_server.port must be a number between 1 and 65535',
          value: httpServerConfig.port,
        });
      }

      // Validate auth if present
      if (httpServerConfig.auth) {
        const auth = httpServerConfig.auth as Record<string, unknown>;
        const validAuthTypes = ['bearer_token', 'hmac', 'basic', 'none'];

        if (!auth.type || !validAuthTypes.includes(auth.type as string)) {
          errors.push({
            field: 'http_server.auth.type',
            message: `Invalid auth type. Must be one of: ${validAuthTypes.join(', ')}`,
            value: auth.type,
          });
        }
      }

      // Validate TLS configuration if present
      if (httpServerConfig.tls && typeof httpServerConfig.tls === 'object') {
        const tls = httpServerConfig.tls as Record<string, unknown>;

        if (tls.enabled === true) {
          // Cert and key are required when TLS is enabled
          if (!tls.cert) {
            errors.push({
              field: 'http_server.tls.cert',
              message: 'TLS certificate is required when TLS is enabled',
            });
          }
          if (!tls.key) {
            errors.push({
              field: 'http_server.tls.key',
              message: 'TLS key is required when TLS is enabled',
            });
          }
        }
      }

      // Validate endpoints if present
      if (httpServerConfig.endpoints && Array.isArray(httpServerConfig.endpoints)) {
        for (let i = 0; i < httpServerConfig.endpoints.length; i++) {
          const endpoint = httpServerConfig.endpoints[i] as Record<string, unknown>;
          if (!endpoint.path || typeof endpoint.path !== 'string') {
            errors.push({
              field: `http_server.endpoints[${i}].path`,
              message: 'Endpoint path must be a string',
              value: endpoint.path,
            });
          }
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
    if (
      process.env.VISOR_NO_REMOTE_EXTENDS === 'true' ||
      process.env.VISOR_NO_REMOTE_EXTENDS === '1'
    ) {
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

// Cache Ajv validator across loads to avoid repeated heavy generation
let __ajvValidate: ((data: unknown) => boolean) | null = null;
let __ajvErrors: (() => import('ajv').ErrorObject[] | null | undefined) | null = null;
let __ajvInitScheduled = false;

function __scheduleAjvBuild(): void {
  if (__ajvInitScheduled || __ajvValidate) return;
  __ajvInitScheduled = true;
  setTimeout(() => {
    try {
      const tjs = require('ts-json-schema-generator');
      const generator = tjs.createGenerator({
        path: path.resolve(__dirname, 'types', 'config.ts'),
        tsconfig: path.resolve(__dirname, '..', 'tsconfig.json'),
        type: 'VisorConfig',
        expose: 'all',
        jsDoc: 'extended',
        skipTypeCheck: false,
        topRef: true,
      });
      const schema = generator.createSchema('VisorConfig');
      const decorate = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        if (obj.type === 'object' && obj.properties) {
          if (obj.additionalProperties === undefined) obj.additionalProperties = false;
          obj.patternProperties = obj.patternProperties || {};
          obj.patternProperties['^x-'] = {};
        }
        for (const key of [
          'definitions',
          '$defs',
          'properties',
          'items',
          'anyOf',
          'allOf',
          'oneOf',
        ]) {
          const child = (obj as any)[key];
          if (Array.isArray(child)) child.forEach(decorate);
          else if (child && typeof child === 'object') Object.values(child).forEach(decorate);
        }
      };
      decorate(schema);
      const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
      addFormats(ajv);
      const validate = ajv.compile(schema);
      __ajvValidate = (data: unknown) => validate(data);
      __ajvErrors = () => validate.errors;
      logger.debug('Ajv schema validator initialized (delayed)');
    } catch (e) {
      logger.debug(`Ajv init failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, 1000);
}
