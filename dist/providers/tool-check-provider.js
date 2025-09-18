"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolCheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
const child_process_1 = require("child_process");
const liquidjs_1 = require("liquidjs");
/**
 * Check provider that executes external tools and commands with Liquid template support
 * Supports both simple commands and complex templated execution with stdin
 */
class ToolCheckProvider extends check_provider_interface_1.CheckProvider {
    liquid;
    constructor() {
        super();
        this.liquid = new liquidjs_1.Liquid({
            strictVariables: false,
            strictFilters: false,
        });
    }
    getName() {
        return 'tool';
    }
    getDescription() {
        return 'Execute external code analysis tools (ESLint, Prettier, etc.)';
    }
    async validateConfig(config) {
        if (!config || typeof config !== 'object') {
            return false;
        }
        const cfg = config;
        // Type must be 'tool'
        if (cfg.type !== 'tool') {
            return false;
        }
        // Must have exec specified for tool execution
        if (typeof cfg.exec !== 'string' || !cfg.exec) {
            return false;
        }
        return true;
    }
    async execute(prInfo, config, _dependencyResults, _sessionInfo) {
        const execTemplate = config.exec;
        const stdinTemplate = config.stdin;
        // Prepare template context
        const templateContext = {
            pr: {
                number: prInfo.number,
                title: prInfo.title,
                body: prInfo.body,
                author: prInfo.author,
                base: prInfo.base,
                head: prInfo.head,
                totalAdditions: prInfo.totalAdditions,
                totalDeletions: prInfo.totalDeletions,
            },
            files: prInfo.files.map(f => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                changes: f.changes,
                patch: f.patch,
            })),
            // Add convenience arrays for common use cases
            filenames: prInfo.files.map(f => f.filename),
            config: config, // Allow access to config values in templates
        };
        // Render the command template
        const renderedCommand = await this.liquid.parseAndRender(execTemplate, templateContext);
        // Render stdin if provided
        let renderedStdin;
        if (stdinTemplate) {
            renderedStdin = await this.liquid.parseAndRender(stdinTemplate, templateContext);
        }
        // Execute the tool
        const output = await this.executeCommand(renderedCommand.trim(), renderedStdin);
        // Parse tool output (this would be customized per tool)
        const comments = this.parseToolOutput(output, renderedCommand);
        const issues = comments.map(comment => ({
            file: comment.file,
            line: comment.line,
            endLine: undefined,
            ruleId: `tool/${comment.category}`,
            message: comment.message,
            severity: comment.severity,
            category: comment.category,
            suggestion: undefined,
            replacement: undefined,
        }));
        return {
            issues,
            suggestions: this.generateSuggestions(comments, renderedCommand),
        };
    }
    async executeCommand(command, stdin) {
        return new Promise((resolve, reject) => {
            // Parse command and arguments (handle quoted arguments)
            const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [command];
            const cmd = parts[0];
            const args = parts.slice(1).map(arg => arg.replace(/^"(.*)"$/, '$1'));
            const child = (0, child_process_1.spawn)(cmd, args, {
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            let output = '';
            let error = '';
            child.stdout.on('data', data => {
                output += data.toString();
            });
            child.stderr.on('data', data => {
                error += data.toString();
            });
            // Send stdin data if provided
            if (stdin) {
                child.stdin.write(stdin);
                child.stdin.end();
            }
            child.on('close', _code => {
                // Many tools return non-zero on issues found
                resolve(output || error);
            });
            child.on('error', err => {
                reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
            });
        });
    }
    parseToolOutput(output, _command) {
        const comments = [];
        // This is a simplified parser - real implementation would handle specific tool formats
        const lines = output.split('\n');
        for (const line of lines) {
            // Example: file.js:10:5: error: Missing semicolon
            const match = line.match(/^(.+?):(\d+):(\d+):\s*(critical|error|warning|info):\s*(.+)$/);
            if (match) {
                comments.push({
                    file: match[1],
                    line: parseInt(match[2]),
                    message: match[5],
                    severity: match[4],
                    category: 'style',
                });
            }
        }
        return comments;
    }
    generateSuggestions(comments, command) {
        const suggestions = [];
        if (comments.length > 0) {
            suggestions.push(`Fix ${comments.length} issues found by ${command}`);
            const errorCount = comments.filter(c => c.severity === 'error').length;
            if (errorCount > 0) {
                suggestions.push(`Priority: Fix ${errorCount} errors before merging`);
            }
        }
        return suggestions;
    }
    getSupportedConfigKeys() {
        return ['type', 'exec', 'command', 'stdin', 'timeout', 'workingDirectory'];
    }
    async isAvailable() {
        // Check if common tools are available
        // In a real implementation, this would check for specific tools based on config
        return true;
    }
    getRequirements() {
        return [
            'External tool must be installed (e.g., eslint, prettier)',
            'Tool must be accessible in PATH',
            'Appropriate configuration files for the tool',
        ];
    }
}
exports.ToolCheckProvider = ToolCheckProvider;
//# sourceMappingURL=tool-check-provider.js.map