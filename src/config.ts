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
 * Valid event triggers for checks
 * Exported as a constant to serve as the single source of truth for event validation
 */
export const VALID_EVENT_TRIGGERS: readonly EventTrigger[] = [
  'pr_opened',
  'pr_updated',
  'pr_closed',
  'issue_opened',
  'issue_comment',
  'manual',
  'schedule',
  'webhook_received',
] as const;

/**
 * Configuration manager for Visor
 */
export class ConfigManager {
  private validCheckTypes: ConfigCheckType[] = [
    'ai',
    'claude-code',
    'mcp',
    'command',
    'http',
    'http_input',
    'http_client',
    'memory',
    'noop',
    'log',
    'github',
    'human-input',
  ];
  private validEventTriggers: EventTrigger[] = [...VALID_EVENT_TRIGGERS];
  private validOutputFormats: ConfigOutputFormat[] = ['table', 'json', 'markdown', 'sarif'];
  private validGroupByOptions: GroupByOption[] = ['check', 'file', 'severity', 'group'];

  /**
   * Load configuration from a file
   */
  public async loadConfig(
    configPath: string,
    options: ConfigLoadOptions = {}
  ): Promise<VisorConfig> {
    const { validate = true, mergeDefaults = true, allowedRemotePatterns } = options;

    // Resolve relative paths to absolute paths based on current working directory
    const resolvedPath = path.isAbsolute(configPath)
      ? configPath
      : path.resolve(process.cwd(), configPath);

    try {
      let configContent: string;
      try {
        // Attempt to read directly; if not found or not accessible, an error will be thrown
        configContent = fs.readFileSync(resolvedPath, 'utf8');
      } catch (readErr: any) {
        if (readErr && (readErr.code === 'ENOENT' || readErr.code === 'ENOTDIR')) {
          throw new Error(`Configuration file not found: ${resolvedPath}`);
        }
        throw new Error(
          `Failed to read configuration file ${resolvedPath}: ${readErr?.message || String(readErr)}`
        );
      }
      let parsedConfig: Partial<VisorConfig>;

      try {
        parsedConfig = yaml.load(configContent) as Partial<VisorConfig>;
      } catch (yamlError) {
        const errorMessage = yamlError instanceof Error ? yamlError.message : String(yamlError);
        throw new Error(`Invalid YAML syntax in ${resolvedPath}: ${errorMessage}`);
      }

      if (!parsedConfig || typeof parsedConfig !== 'object') {
        throw new Error('Configuration file must contain a valid YAML object');
      }

      // Handle extends directive if present
      if (parsedConfig.extends) {
        const loaderOptions: ConfigLoaderOptions = {
          baseDir: path.dirname(resolvedPath),
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

      // Normalize 'checks' and 'steps' - support both keys for backward compatibility
      parsedConfig = this.normalizeStepsAndChecks(parsedConfig);

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
          throw new Error(`Configuration file not found: ${resolvedPath}`);
        }
        if (error.message.includes('EPERM')) {
          throw new Error(`Permission denied reading configuration file: ${resolvedPath}`);
        }
        throw new Error(`Failed to read configuration file ${resolvedPath}: ${error.message}`);
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
      const candidates = ['visor.yaml', 'visor.yml', '.visor.yaml', '.visor.yml'].map(p =>
        path.join(baseDir, p)
      );

      for (const p of candidates) {
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) continue;
          const isLegacy = path.basename(p).startsWith('.');
          if (isLegacy) {
            // Allow legacy dotfile unless strict mode enabled
            if (process.env.VISOR_STRICT_CONFIG_NAME === 'true') {
              const rel = path.relative(baseDir, p);
              throw new Error(
                `Legacy config detected: ${rel}. Please rename to visor.yaml (or visor.yml).`
              );
            }
            return this.loadConfig(p, options);
          }
          return this.loadConfig(p, options);
        } catch (e: any) {
          if (e && e.code === 'ENOENT') continue; // try next
          // Surface unexpected errors
          if (e) throw e;
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
      steps: {},
      checks: {}, // Keep for backward compatibility
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
        // Only support new non-dot filename
        possiblePaths.push(
          path.join(__dirname, 'defaults', 'visor.yaml'),
          path.join(__dirname, '..', 'defaults', 'visor.yaml')
        );
      }

      // Try via package root
      const pkgRoot = this.findPackageRoot();
      if (pkgRoot) {
        possiblePaths.push(path.join(pkgRoot, 'defaults', 'visor.yaml'));
      }

      // GitHub Action environment variable
      if (process.env.GITHUB_ACTION_PATH) {
        possiblePaths.push(
          path.join(process.env.GITHUB_ACTION_PATH, 'defaults', 'visor.yaml'),
          path.join(process.env.GITHUB_ACTION_PATH, 'dist', 'defaults', 'visor.yaml')
        );
      }

      let bundledConfigPath: string | undefined;
      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          bundledConfigPath = possiblePath;
          break;
        }
      }

      if (bundledConfigPath) {
        // Always log to stderr to avoid contaminating formatted output
        console.error(`📦 Loading bundled default configuration from ${bundledConfigPath}`);
        const configContent = fs.readFileSync(bundledConfigPath, 'utf8');
        let parsedConfig = yaml.load(configContent) as Partial<VisorConfig>;

        if (!parsedConfig || typeof parsedConfig !== 'object') {
          return null;
        }

        // Normalize 'checks' and 'steps' for backward compatibility
        parsedConfig = this.normalizeStepsAndChecks(parsedConfig);

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
   * Normalize 'checks' and 'steps' keys for backward compatibility
   * Ensures both keys are present and contain the same data
   */
  private normalizeStepsAndChecks(config: Partial<VisorConfig>): Partial<VisorConfig> {
    // If both are present, 'steps' takes precedence
    if (config.steps && config.checks) {
      // Use steps as the source of truth
      config.checks = config.steps;
    } else if (config.steps && !config.checks) {
      // Copy steps to checks for internal compatibility
      config.checks = config.steps;
    } else if (config.checks && !config.steps) {
      // Copy checks to steps for forward compatibility
      config.steps = config.checks;
    }

    return config;
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
   * @param config The config to validate
   * @param strict If true, treat warnings as errors (default: false)
   */
  public validateConfig(config: Partial<VisorConfig>, strict = false): void {
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

    // Unknown key warnings are produced by Ajv using the pre-generated schema.

    // Validate that either 'checks' or 'steps' is present
    if (!config.checks && !config.steps) {
      errors.push({
        field: 'checks/steps',
        message:
          'Missing required field: either "checks" or "steps" must be defined. "steps" is recommended for new configurations.',
      });
    }

    // Use normalized checks for validation (both should be present after normalization)
    const checksToValidate = config.checks || config.steps;
    if (checksToValidate) {
      // Validate each check configuration
      for (const [checkName, checkConfig] of Object.entries(checksToValidate)) {
        // Default type to 'ai' if not specified
        if (!checkConfig.type) {
          checkConfig.type = 'ai';
        }
        // 'on' field is optional - if not specified, check can run on any event
        this.validateCheckConfig(checkName, checkConfig, errors, config);

        // Unknown/typo keys at the check level are produced by Ajv.

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

        // Type-specific guidance for MCP placement to avoid silent ignores
        try {
          const anyCheck = checkConfig as unknown as Record<string, unknown>;
          const aiObj = (anyCheck.ai as Record<string, unknown>) || undefined;
          const hasBareMcpAtCheck = Object.prototype.hasOwnProperty.call(anyCheck, 'mcpServers');
          const hasAiMcp = aiObj && Object.prototype.hasOwnProperty.call(aiObj, 'mcpServers');
          const hasClaudeCodeMcp =
            anyCheck.claude_code &&
            typeof anyCheck.claude_code === 'object' &&
            Object.prototype.hasOwnProperty.call(
              anyCheck.claude_code as Record<string, unknown>,
              'mcpServers'
            );

          if (checkConfig.type === 'ai') {
            if (hasBareMcpAtCheck) {
              warnings.push({
                field: `checks.${checkName}.mcpServers`,
                message:
                  "'mcpServers' at the check root is ignored for type 'ai'. Use 'ai.mcpServers' or 'ai_mcp_servers' instead.",
                value: (anyCheck as any).mcpServers,
              });
            }
            if (hasClaudeCodeMcp) {
              warnings.push({
                field: `checks.${checkName}.claude_code.mcpServers`,
                message:
                  "'claude_code.mcpServers' is ignored for type 'ai'. Use 'ai.mcpServers' or 'ai_mcp_servers' instead.",
              });
            }
          }

          if (checkConfig.type === 'claude-code') {
            if (hasAiMcp || checkConfig.ai_mcp_servers) {
              warnings.push({
                field: hasAiMcp
                  ? `checks.${checkName}.ai.mcpServers`
                  : `checks.${checkName}.ai_mcp_servers`,
                message:
                  "For type 'claude-code', MCP must be configured under 'claude_code.mcpServers'. 'ai.mcpServers' and 'ai_mcp_servers' are ignored for this check.",
              });
            }
          }
        } catch {
          // best-effort hints; never fail validation here
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

    // In strict mode, treat warnings as errors
    if (strict && warnings.length > 0) {
      errors.push(...warnings);
    }

    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    // Emit warnings (do not block execution) - only in non-strict mode
    if (!strict && warnings.length > 0) {
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
    errors: ConfigValidationError[],
    config?: Partial<VisorConfig>
  ): void {
    // Default to 'ai' if no type specified
    if (!checkConfig.type) {
      checkConfig.type = 'ai';
    }
    // Backward-compat alias: accept 'logger' as 'log'
    if ((checkConfig as any).type === 'logger') {
      (checkConfig as any).type = 'log';
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

    // Note: Do not add special-case validation for log 'message' here.
    // Schema (Ajv) permits 'message' and related keys; provider enforces at execution time.

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
      const isString = typeof checkConfig.reuse_ai_session === 'string';
      const isBoolean = typeof checkConfig.reuse_ai_session === 'boolean';

      if (!isString && !isBoolean) {
        errors.push({
          field: `checks.${checkName}.reuse_ai_session`,
          message: `Invalid reuse_ai_session value for "${checkName}": must be string (check name) or boolean`,
          value: checkConfig.reuse_ai_session,
        });
      } else if (isString) {
        // When reuse_ai_session is a string, it must refer to a valid check
        const targetCheckName = checkConfig.reuse_ai_session as string;
        if (!config?.checks || !config.checks[targetCheckName]) {
          errors.push({
            field: `checks.${checkName}.reuse_ai_session`,
            message: `Check "${checkName}" references non-existent check "${targetCheckName}" for session reuse`,
            value: checkConfig.reuse_ai_session,
          });
        }
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

    // Validate session_mode configuration
    if (checkConfig.session_mode !== undefined) {
      if (checkConfig.session_mode !== 'clone' && checkConfig.session_mode !== 'append') {
        errors.push({
          field: `checks.${checkName}.session_mode`,
          message: `Invalid session_mode value for "${checkName}": must be 'clone' or 'append'`,
          value: checkConfig.session_mode,
        });
      }

      // session_mode only makes sense with reuse_ai_session
      if (!checkConfig.reuse_ai_session) {
        errors.push({
          field: `checks.${checkName}.session_mode`,
          message: `Check "${checkName}" has session_mode but no reuse_ai_session. session_mode requires reuse_ai_session to be set.`,
          value: checkConfig.session_mode,
        });
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

    // Validate on_finish configuration
    if (checkConfig.on_finish !== undefined) {
      if (!checkConfig.forEach) {
        errors.push({
          field: `checks.${checkName}.on_finish`,
          message: `Check "${checkName}" has on_finish but forEach is not true. on_finish is only valid on forEach checks.`,
          value: checkConfig.on_finish,
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
        // Preferred fast path: try plain JSON in dist/generated first
        try {
          const jsonPath = path.resolve(__dirname, 'generated', 'config-schema.json');

          const jsonSchema = require(jsonPath);
          if (jsonSchema) {
            const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
            addFormats(ajv);
            const validate = ajv.compile(jsonSchema);
            __ajvValidate = (data: unknown) => validate(data);
            __ajvErrors = () => validate.errors;
          }
        } catch {}
        // Fallback: use embedded TS module (bundled by ncc)
        if (!__ajvValidate) {
          try {
            const mod = require('./generated/config-schema');
            const schema = mod?.configSchema || mod?.default || mod;
            if (schema) {
              const ajv = new Ajv({ allErrors: true, allowUnionTypes: true, strict: false });
              addFormats(ajv);
              const validate = ajv.compile(schema);
              __ajvValidate = (data: unknown) => validate(data);
              __ajvErrors = () => validate.errors;
            } else {
              return;
            }
          } catch {
            return;
          }
        }
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
            // Defer to our existing programmatic validators for required/type errors
            // to preserve friendly, stable error messages and avoid duplication.
            logger.debug(`Ajv note [${pathStr || 'config'}]: ${msg}`);
          }
        }
      }
    } catch (err) {
      logger.debug(`Ajv validation skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Unknown-key warnings are fully handled by Ajv using the generated schema
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
