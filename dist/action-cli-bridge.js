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
exports.ActionCliBridge = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path = __importStar(require("path"));
/**
 * Bridge between GitHub Action and Visor CLI
 */
class ActionCliBridge {
    githubToken;
    context;
    constructor(githubToken, context) {
        this.githubToken = githubToken;
        this.context = context;
    }
    /**
     * Determine if Visor CLI should be used based on inputs
     */
    shouldUseVisor(inputs) {
        return !!(inputs['config-path'] ||
            inputs['visor-config-path'] ||
            inputs.checks ||
            inputs['visor-checks']);
    }
    /**
     * Parse GitHub Action inputs to CLI arguments
     */
    parseGitHubInputsToCliArgs(inputs) {
        const args = [];
        // Add config path if specified (prefer new input name over legacy)
        const configPath = inputs['config-path'] || inputs['visor-config-path'];
        if (configPath && configPath.trim() !== '') {
            args.push('--config', configPath);
        }
        // Add checks if specified (prefer new input name over legacy)
        const checksInput = inputs.checks || inputs['visor-checks'];
        if (checksInput) {
            const checks = checksInput
                .split(',')
                .map(check => check.trim())
                .filter(check => this.isValidCheck(check));
            // CRITICAL FIX: When "all" is specified, don't add any --check arguments
            // This allows CLI to extract all checks from the config file
            if (checks.length > 0 && !checks.includes('all')) {
                // Only add specific checks if "all" is not in the list
                for (const check of checks) {
                    args.push('--check', check);
                }
            }
            // When checks includes 'all', we intentionally don't add any --check arguments
            // The CLI will then use all checks defined in .visor.yaml
        }
        // Add output format if specified
        if (inputs['output-format']) {
            args.push('--output', inputs['output-format']);
        }
        else {
            // Always use JSON output for programmatic processing
            args.push('--output', 'json');
        }
        // Add debug flag if enabled
        if (inputs.debug === 'true') {
            args.push('--debug');
        }
        // Add max parallelism if specified
        if (inputs['max-parallelism']) {
            args.push('--max-parallelism', inputs['max-parallelism']);
        }
        // Add fail-fast flag if enabled
        if (inputs['fail-fast'] === 'true') {
            args.push('--fail-fast');
        }
        return args;
    }
    /**
     * Execute CLI with GitHub context
     */
    async executeCliWithContext(inputs, options = {}) {
        const { workingDir = process.cwd(), timeout = 300000 } = options; // 5 min timeout
        try {
            const cliArgs = this.parseGitHubInputsToCliArgs(inputs);
            // Set up environment variables for CLI
            const env = {
                ...process.env,
                GITHUB_EVENT_NAME: this.context.event_name,
                GITHUB_CONTEXT: JSON.stringify(this.context),
                GITHUB_REPOSITORY_OWNER: this.context.repository?.owner.login || inputs.owner || '',
                GITHUB_REPOSITORY: this.context.repository
                    ? `${this.context.repository.owner.login}/${this.context.repository.name}`
                    : `${inputs.owner || ''}/${inputs.repo || ''}`,
            };
            // Pass GitHub App credentials if they exist in inputs
            if (inputs['app-id']) {
                env.INPUT_APP_ID = inputs['app-id'];
            }
            if (inputs['private-key']) {
                env.INPUT_PRIVATE_KEY = inputs['private-key'];
            }
            if (inputs['installation-id']) {
                env.INPUT_INSTALLATION_ID = inputs['installation-id'];
            }
            // Only set GITHUB_TOKEN if we're not using GitHub App authentication
            const isUsingGitHubApp = inputs['app-id'] && inputs['private-key'];
            if (this.githubToken && !isUsingGitHubApp) {
                env.GITHUB_TOKEN = this.githubToken;
            }
            console.log(`🚀 Executing Visor CLI with args: ${cliArgs.join(' ')}`);
            const result = await this.executeCommand('node', ['dist/cli-main.js', ...cliArgs], {
                cwd: workingDir,
                env,
                timeout,
            });
            if (result.exitCode === 0) {
                // Try to parse CLI output for additional data
                const cliOutput = this.parseCliOutput(result.output);
                return {
                    success: true,
                    output: result.output,
                    exitCode: result.exitCode,
                    cliOutput,
                };
            }
            else {
                return {
                    success: false,
                    output: result.output,
                    error: result.error,
                    exitCode: result.exitCode,
                };
            }
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
                exitCode: -1,
            };
        }
    }
    /**
     * Merge CLI and Action outputs for backward compatibility
     */
    mergeActionAndCliOutputs(actionInputs, cliResult, legacyOutputs) {
        const outputs = {
            // Preserve legacy outputs if present
            ...(legacyOutputs || {}),
        };
        if (cliResult.success && cliResult.cliOutput) {
            const cli = cliResult.cliOutput;
            if (cli.reviewScore !== undefined) {
                outputs['review-score'] = cli.reviewScore.toString();
            }
            if (cli.issuesFound !== undefined) {
                outputs['issues-found'] = cli.issuesFound.toString();
            }
            if (cli.autoReviewCompleted !== undefined) {
                outputs['auto-review-completed'] = cli.autoReviewCompleted.toString();
            }
        }
        return outputs;
    }
    /**
     * Execute command with timeout and proper error handling
     */
    executeCommand(command, args, options = {}) {
        return new Promise((resolve, reject) => {
            const { cwd, env, timeout = 30000 } = options;
            const child = (0, child_process_1.spawn)(command, args, {
                cwd,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            let error = '';
            let timeoutHandle = null;
            if (child.stdout) {
                child.stdout.on('data', data => {
                    output += data.toString();
                });
            }
            if (child.stderr) {
                child.stderr.on('data', data => {
                    error += data.toString();
                });
            }
            child.on('close', code => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }
                resolve({
                    output: output.trim(),
                    error: error.trim(),
                    exitCode: code || 0,
                });
            });
            child.on('error', err => {
                if (timeoutHandle) {
                    clearTimeout(timeoutHandle);
                }
                reject(new Error(`Command execution failed: ${err.message}`));
            });
            // Set timeout if specified
            if (timeout > 0) {
                timeoutHandle = setTimeout(() => {
                    child.kill('SIGTERM');
                    reject(new Error(`Command execution timed out after ${timeout}ms`));
                }, timeout);
            }
        });
    }
    /**
     * Parse CLI JSON output to extract relevant data
     */
    parseCliOutput(output) {
        try {
            // Look for JSON output in the CLI result
            const lines = output.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    const parsed = JSON.parse(trimmed);
                    // Extract relevant data that can be used for Action outputs
                    return {
                        reviewScore: parsed.reviewScore || parsed.overallScore,
                        issuesFound: parsed.issuesFound || parsed.totalIssues,
                        autoReviewCompleted: parsed.autoReviewCompleted || false,
                    };
                }
            }
            return {};
        }
        catch {
            console.log('Could not parse CLI output as JSON, using default values');
            return {};
        }
    }
    /**
     * Check if a check type is valid
     */
    isValidCheck(check) {
        const validChecks = ['performance', 'architecture', 'security', 'style', 'all'];
        return validChecks.includes(check);
    }
    /**
     * Create temporary config file from action inputs
     */
    async createTempConfigFromInputs(inputs, options = {}) {
        const { workingDir = process.cwd() } = options;
        if (!inputs['visor-checks']) {
            return null;
        }
        const checks = inputs['visor-checks']
            .split(',')
            .map(check => check.trim())
            .filter(check => this.isValidCheck(check));
        if (checks.length === 0) {
            return null;
        }
        // Create a basic Visor config from the checks
        const config = {
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
        // Map GitHub Action checks to Visor config format
        for (const check of checks) {
            const checkName = `${check}-check`;
            config.checks[checkName] = {
                type: 'ai',
                prompt: this.getPromptForCheck(check),
                on: ['pr_opened', 'pr_updated'],
            };
        }
        // Write temporary config file
        const tempConfigPath = path.join(workingDir, '.visor-temp.yaml');
        try {
            const yaml = require('js-yaml');
            const yamlContent = yaml.dump(config);
            await fs_1.promises.writeFile(tempConfigPath, yamlContent, 'utf8');
            return tempConfigPath;
        }
        catch (error) {
            console.error('Failed to create temporary config file:', error);
            return null;
        }
    }
    /**
     * Get AI prompt for a specific check type
     */
    getPromptForCheck(check) {
        const prompts = {
            security: `Review this code for security vulnerabilities, focusing on:
- SQL injection, XSS, CSRF vulnerabilities
- Authentication and authorization flaws
- Sensitive data exposure
- Input validation issues
- Cryptographic weaknesses`,
            performance: `Analyze this code for performance issues, focusing on:
- Database query efficiency (N+1 problems, missing indexes)
- Memory usage and potential leaks
- Algorithmic complexity issues
- Caching opportunities
- Resource utilization`,
            architecture: `Review the architectural aspects of this code, focusing on:
- Design patterns and code organization
- Separation of concerns
- SOLID principles adherence
- Code maintainability and extensibility
- Technical debt`,
            style: `Review code style and maintainability, focusing on:
- Consistent naming conventions
- Code formatting and readability
- Documentation quality
- Error handling patterns
- Code complexity`,
            all: `Perform a comprehensive code review covering:
- Security vulnerabilities and best practices
- Performance optimization opportunities
- Architectural improvements
- Code style and maintainability
- Documentation and testing coverage`,
        };
        return prompts[check];
    }
    /**
     * Cleanup temporary files
     */
    async cleanup(options = {}) {
        const { workingDir = process.cwd() } = options;
        const tempConfigPath = path.join(workingDir, '.visor-temp.yaml');
        try {
            await fs_1.promises.unlink(tempConfigPath);
        }
        catch {
            // Ignore cleanup errors
        }
    }
}
exports.ActionCliBridge = ActionCliBridge;
//# sourceMappingURL=action-cli-bridge.js.map