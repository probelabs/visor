import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewComment, ReviewIssue } from '../reviewer';
import { spawn } from 'child_process';

/**
 * Check provider that executes external tools (linters, analyzers, etc.)
 */
export class ToolCheckProvider extends CheckProvider {
  getName(): string {
    return 'tool';
  }

  getDescription(): string {
    return 'Execute external code analysis tools (ESLint, Prettier, etc.)';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

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

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const command = config.command as string;
    const args = (config.args as string[]) || [];
    const files = prInfo.files.map(f => f.filename);

    // Execute the tool
    const output = await this.executeCommand(command, args, files);

    // Parse tool output (this would be customized per tool)
    const comments = this.parseToolOutput(output, command);

    const issues: ReviewIssue[] = comments.map(comment => ({
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

  private async executeCommand(command: string, args: string[], files: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args, ...files], {
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

  private parseToolOutput(output: string, _command: string): ReviewComment[] {
    const comments: ReviewComment[] = [];

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
          severity: match[4] as 'critical' | 'error' | 'warning' | 'info',
          category: 'style',
        });
      }
    }

    return comments;
  }

  private generateSuggestions(comments: ReviewComment[], command: string): string[] {
    const suggestions: string[] = [];

    if (comments.length > 0) {
      suggestions.push(`Fix ${comments.length} issues found by ${command}`);

      const errorCount = comments.filter(c => c.severity === 'error').length;
      if (errorCount > 0) {
        suggestions.push(`Priority: Fix ${errorCount} errors before merging`);
      }
    }

    return suggestions;
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'command', 'args', 'timeout', 'workingDirectory'];
  }

  async isAvailable(): Promise<boolean> {
    // Check if common tools are available
    // In a real implementation, this would check for specific tools based on config
    return true;
  }

  getRequirements(): string[] {
    return [
      'External tool must be installed (e.g., eslint, prettier)',
      'Tool must be accessible in PATH',
      'Appropriate configuration files for the tool',
    ];
  }
}
