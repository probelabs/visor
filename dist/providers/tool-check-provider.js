"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolCheckProvider = void 0;
const check_provider_interface_1 = require("./check-provider.interface");
const child_process_1 = require("child_process");
/**
 * Check provider that executes external tools (linters, analyzers, etc.)
 */
class ToolCheckProvider extends check_provider_interface_1.CheckProvider {
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
        // Must have command specified
        if (typeof cfg.command !== 'string' || !cfg.command) {
            return false;
        }
        return true;
    }
    async execute(prInfo, config, _dependencyResults) {
        const command = config.command;
        const args = config.args || [];
        const files = prInfo.files.map(f => f.filename);
        // Execute the tool
        const output = await this.executeCommand(command, args, files);
        // Parse tool output (this would be customized per tool)
        const comments = this.parseToolOutput(output, command);
        const issues = comments.map(comment => ({
            file: comment.file,
            line: comment.line,
            endLine: undefined,
            ruleId: `${command}/${comment.category}`,
            message: comment.message,
            severity: comment.severity,
            category: comment.category,
            suggestion: undefined,
            replacement: undefined,
        }));
        return {
            issues,
            suggestions: this.generateSuggestions(comments, command),
        };
    }
    async executeCommand(command, args, files) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(command, [...args, ...files], {
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
            child.on('close', _code => {
                // Many linters return non-zero on issues found
                resolve(output || error);
            });
            child.on('error', err => {
                reject(new Error(`Failed to execute ${command}: ${err.message}`));
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
        return ['type', 'command', 'args', 'timeout', 'workingDirectory'];
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