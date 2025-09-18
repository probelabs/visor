"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const yaml = __importStar(require("js-yaml"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const simple_git_1 = __importDefault(require("simple-git"));
/**
 * Configuration manager for Visor
 */
class ConfigManager {
    validCheckTypes = ['ai', 'tool', 'webhook', 'noop'];
    validEventTriggers = [
        'pr_opened',
        'pr_updated',
        'pr_closed',
        'issue_opened',
        'issue_comment',
        'manual',
    ];
    validOutputFormats = ['table', 'json', 'markdown', 'sarif'];
    validGroupByOptions = ['check', 'file', 'severity'];
    /**
     * Load configuration from a file
     */
    async loadConfig(configPath, options = {}) {
        const { validate = true, mergeDefaults = true } = options;
        try {
            if (!fs.existsSync(configPath)) {
                throw new Error(`Configuration file not found: ${configPath}`);
            }
            const configContent = fs.readFileSync(configPath, 'utf8');
            let parsedConfig;
            try {
                parsedConfig = yaml.load(configContent);
            }
            catch (yamlError) {
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
            return finalConfig;
        }
        catch (error) {
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
    async findAndLoadConfig() {
        // Try to find the git repository root first, fall back to current directory
        const gitRoot = await this.findGitRepositoryRoot();
        const searchDirs = [gitRoot, process.cwd()].filter(Boolean);
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
    async findGitRepositoryRoot() {
        try {
            const git = (0, simple_git_1.default)();
            const isRepo = await git.checkIsRepo();
            if (!isRepo) {
                return null;
            }
            // Get the repository root directory
            const rootDir = await git.revparse(['--show-toplevel']);
            return rootDir.trim();
        }
        catch {
            // Not in a git repository or git not available
            return null;
        }
    }
    /**
     * Get default configuration
     */
    async getDefaultConfig() {
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
    loadBundledDefaultConfig() {
        try {
            // Find the package root by looking for package.json
            const packageRoot = this.findPackageRoot();
            if (!packageRoot) {
                return null;
            }
            const bundledConfigPath = path.join(packageRoot, 'defaults', '.visor.yaml');
            if (fs.existsSync(bundledConfigPath)) {
                const configContent = fs.readFileSync(bundledConfigPath, 'utf8');
                const parsedConfig = yaml.load(configContent);
                if (!parsedConfig || typeof parsedConfig !== 'object') {
                    return null;
                }
                // Validate and merge with defaults
                this.validateConfig(parsedConfig);
                return this.mergeWithDefaults(parsedConfig);
            }
        }
        catch (error) {
            // Silently fail and return null - will fall back to minimal default
            console.warn('Failed to load bundled default config:', error instanceof Error ? error.message : String(error));
        }
        return null;
    }
    /**
     * Find the root directory of the Visor package
     */
    findPackageRoot() {
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
                }
                catch {
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
    mergeWithCliOptions(config, cliOptions) {
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
    async loadConfigWithEnvOverrides() {
        const environmentOverrides = {};
        // Check for environment variable overrides
        if (process.env.VISOR_CONFIG_PATH) {
            environmentOverrides.configPath = process.env.VISOR_CONFIG_PATH;
        }
        if (process.env.VISOR_OUTPUT_FORMAT) {
            environmentOverrides.outputFormat = process.env.VISOR_OUTPUT_FORMAT;
        }
        let config;
        if (environmentOverrides.configPath) {
            try {
                config = await this.loadConfig(environmentOverrides.configPath);
            }
            catch {
                // If environment config fails, fall back to default discovery
                config = await this.findAndLoadConfig();
            }
        }
        else {
            config = await this.findAndLoadConfig();
        }
        return { config, environmentOverrides };
    }
    /**
     * Validate configuration against schema
     */
    validateConfig(config) {
        const errors = [];
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
        }
        else {
            // Validate each check configuration
            for (const [checkName, checkConfig] of Object.entries(config.checks)) {
                this.validateCheckConfig(checkName, checkConfig, errors);
            }
        }
        // Validate output configuration if present
        if (config.output) {
            this.validateOutputConfig(config.output, errors);
        }
        // Validate max_parallelism if present
        if (config.max_parallelism !== undefined) {
            if (typeof config.max_parallelism !== 'number' ||
                config.max_parallelism < 1 ||
                !Number.isInteger(config.max_parallelism)) {
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
    validateCheckConfig(checkName, checkConfig, errors) {
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
        }
        else {
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
            }
            else if (checkConfig.reuse_ai_session === true) {
                // When reuse_ai_session is true, depends_on must be specified and non-empty
                if (!checkConfig.depends_on ||
                    !Array.isArray(checkConfig.depends_on) ||
                    checkConfig.depends_on.length === 0) {
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
    validateOutputConfig(outputConfig, errors) {
        if (outputConfig.pr_comment) {
            const prComment = outputConfig.pr_comment;
            if (typeof prComment.format === 'string' &&
                !this.validOutputFormats.includes(prComment.format)) {
                errors.push({
                    field: 'output.pr_comment.format',
                    message: `Invalid output format "${prComment.format}". Must be one of: ${this.validOutputFormats.join(', ')}`,
                    value: prComment.format,
                });
            }
            if (typeof prComment.group_by === 'string' &&
                !this.validGroupByOptions.includes(prComment.group_by)) {
                errors.push({
                    field: 'output.pr_comment.group_by',
                    message: `Invalid group_by option "${prComment.group_by}". Must be one of: ${this.validGroupByOptions.join(', ')}`,
                    value: prComment.group_by,
                });
            }
        }
    }
    /**
     * Merge configuration with default values
     */
    mergeWithDefaults(config) {
        const defaultConfig = {
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
        // Deep merge with defaults
        const merged = { ...defaultConfig, ...config };
        // Ensure output has default values
        if (merged.output) {
            merged.output.pr_comment = {
                ...defaultConfig.output.pr_comment,
                ...merged.output.pr_comment,
            };
        }
        else {
            merged.output = defaultConfig.output;
        }
        return merged;
    }
}
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=config.js.map