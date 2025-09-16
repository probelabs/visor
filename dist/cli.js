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
exports.CLI = void 0;
const commander_1 = require("commander");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * CLI argument parser and command handler
 */
class CLI {
    program;
    validChecks = ['performance', 'architecture', 'security', 'style', 'all'];
    validOutputs = ['table', 'json', 'markdown', 'sarif'];
    constructor() {
        this.program = new commander_1.Command();
        this.setupProgram();
    }
    /**
     * Set up the commander program with options and validation
     */
    setupProgram() {
        this.program
            .name('visor')
            .description('Visor - AI-powered code review tool')
            .version(this.getVersion())
            .option('-c, --check <type>', 'Specify check type (can be used multiple times)', this.collectChecks, [])
            .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
            .option('--config <path>', 'Path to configuration file')
            .option('--timeout <ms>', 'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)', value => parseInt(value, 10))
            .option('--max-parallelism <count>', 'Maximum number of checks to run in parallel (default: 3)', value => parseInt(value, 10))
            .option('--debug', 'Enable debug mode for detailed output')
            .option('--fail-fast', 'Stop execution on first failure condition')
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
    collectChecks = (value, previous) => {
        return previous.concat([value]);
    };
    /**
     * Parse command line arguments
     */
    parseArgs(argv) {
        try {
            // Create a fresh program instance for each parse to avoid state issues
            const tempProgram = new commander_1.Command();
            tempProgram
                .name('visor')
                .description('Visor - AI-powered code review tool')
                .version(this.getVersion())
                .option('-c, --check <type>', 'Specify check type (can be used multiple times)', this.collectChecks, [])
                .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
                .option('--config <path>', 'Path to configuration file')
                .option('--timeout <ms>', 'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)', value => parseInt(value, 10))
                .option('--max-parallelism <count>', 'Maximum number of checks to run in parallel (default: 3)', value => parseInt(value, 10))
                .option('--debug', 'Enable debug mode for detailed output')
                .option('--fail-fast', 'Stop execution on first failure condition')
                .allowUnknownOption(false)
                .allowExcessArguments(false) // Don't allow positional arguments
                .addHelpText('after', this.getExamplesText())
                .exitOverride(); // Prevent process.exit during tests
            tempProgram.parse(argv, { from: 'user' });
            const options = tempProgram.opts();
            // Validate options
            this.validateOptions(options);
            // Remove duplicates and preserve order
            const uniqueChecks = [...new Set(options.check)];
            return {
                checks: uniqueChecks,
                output: options.output,
                configPath: options.config,
                timeout: options.timeout,
                maxParallelism: options.maxParallelism,
                debug: options.debug,
                failFast: options.failFast,
                help: options.help,
                version: options.version,
            };
        }
        catch (error) {
            if (error instanceof Error) {
                // Handle commander.js specific errors
                if (error.message.includes('unknown option') || error.message.includes('Unknown option')) {
                    throw error;
                }
                if (error.message.includes('Missing required argument') ||
                    error.message.includes('argument missing')) {
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
    validateOptions(options) {
        // Validate check types
        if (Array.isArray(options.check) && options.check.length > 0) {
            for (const check of options.check) {
                if (!this.validChecks.includes(check)) {
                    throw new Error(`Invalid check type: ${check}. Available options: ${this.validChecks.join(', ')}`);
                }
            }
        }
        // Validate output format
        if (options.output && !this.validOutputs.includes(options.output)) {
            throw new Error(`Invalid output format: ${options.output}. Available options: ${this.validOutputs.join(', ')}`);
        }
        // Validate timeout
        if (options.timeout !== undefined) {
            if (typeof options.timeout !== 'number' || isNaN(options.timeout) || options.timeout < 0) {
                throw new Error(`Invalid timeout value: ${options.timeout}. Timeout must be a positive number in milliseconds.`);
            }
        }
        // Validate max parallelism
        if (options.maxParallelism !== undefined) {
            if (typeof options.maxParallelism !== 'number' ||
                isNaN(options.maxParallelism) ||
                options.maxParallelism < 1) {
                throw new Error(`Invalid max parallelism value: ${options.maxParallelism}. Max parallelism must be a positive integer (minimum 1).`);
            }
        }
    }
    /**
     * Get help text
     */
    getHelpText() {
        // Use the same configuration as parseArgs to ensure consistency
        const tempProgram = new commander_1.Command();
        tempProgram
            .name('visor')
            .description('Visor - AI-powered code review tool')
            .version(this.getVersion())
            .option('-c, --check <type>', 'Specify check type (can be used multiple times)', this.collectChecks, [])
            .option('-o, --output <format>', 'Output format (table, json, markdown, sarif)', 'table')
            .option('--config <path>', 'Path to configuration file')
            .option('--timeout <ms>', 'Timeout for check operations in milliseconds (default: 600000ms / 10 minutes)', value => parseInt(value, 10))
            .option('--max-parallelism <count>', 'Maximum number of checks to run in parallel (default: 3)', value => parseInt(value, 10))
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
    getVersion() {
        try {
            const packageJsonPath = path.join(__dirname, '../../package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                return packageJson.version || '1.0.0';
            }
        }
        catch {
            // Fallback to default version
        }
        return '1.0.0';
    }
    /**
     * Get examples text for help
     */
    getExamplesText() {
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
    showHelp() {
        this.program.help();
    }
    /**
     * Display version
     */
    showVersion() {
        console.log(this.getVersion());
    }
}
exports.CLI = CLI;
//# sourceMappingURL=cli.js.map