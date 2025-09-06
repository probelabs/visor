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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const yaml = __importStar(require("js-yaml"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Configuration manager for Visor
 */
class ConfigManager {
    validCheckTypes = ['ai'];
    validEventTriggers = ['pr_opened', 'pr_updated', 'pr_closed'];
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
        const currentDir = process.cwd();
        const possiblePaths = [
            path.join(currentDir, 'visor.config.yaml'),
            path.join(currentDir, 'visor.config.yml'),
        ];
        for (const configPath of possiblePaths) {
            if (fs.existsSync(configPath)) {
                return this.loadConfig(configPath);
            }
        }
        // Return default config if no file found
        return this.getDefaultConfig();
    }
    /**
     * Get default configuration
     */
    async getDefaultConfig() {
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
    mergeWithCliOptions(config, cliOptions) {
        return {
            config,
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