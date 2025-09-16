import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary, ReviewIssue } from '../reviewer';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';

/**
 * Check provider that executes custom scripts for analysis
 */
export class ScriptCheckProvider extends CheckProvider {
  getName(): string {
    return 'script';
  }

  getDescription(): string {
    return 'Execute custom scripts for code analysis and review';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'script'
    if (cfg.type !== 'script') {
      return false;
    }

    // Must have script path specified
    if (typeof cfg.script !== 'string' || !cfg.script) {
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
    const scriptPath = config.script as string;
    const interpreter = (config.interpreter as string) || 'bash';

    // Prepare input for the script (PR info as JSON)
    const scriptInput = JSON.stringify({
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      files: prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      })),
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
    });

    // Execute the script
    const output = await this.executeScript(interpreter, scriptPath, scriptInput);

    // Parse script output (expected to be JSON)
    return this.parseScriptOutput(output, scriptPath);
  }

  private async executeScript(
    interpreter: string,
    scriptPath: string,
    input: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      // Check if script exists
      if (!fs.access(scriptPath)) {
        reject(new Error(`Script not found: ${scriptPath}`));
        return;
      }

      const child = spawn(interpreter, [scriptPath], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let error = '';

      // Write input to script's stdin
      child.stdin.write(input);
      child.stdin.end();

      child.stdout.on('data', data => {
        output += data.toString();
      });

      child.stderr.on('data', data => {
        error += data.toString();
      });

      child.on('close', code => {
        if (code !== 0) {
          console.error(`Script exited with code ${code}: ${error}`);
        }
        resolve(output);
      });

      child.on('error', err => {
        reject(new Error(`Failed to execute script: ${err.message}`));
      });
    });
  }

  private parseScriptOutput(output: string, scriptPath: string): ReviewSummary {
    try {
      // Expect script to output JSON in ReviewSummary format
      const result = JSON.parse(output);

      // Convert to ReviewIssue format
      const issues: ReviewIssue[] = Array.isArray(result.comments)
        ? (result.comments as Array<Record<string, unknown>>).map(c => ({
            file: c.file || 'unknown',
            line: c.line || 0,
            endLine: c.endLine,
            ruleId: c.ruleId || `script/${this.validateCategory(c.category)}`,
            message: c.message || '',
            severity: this.validateSeverity(c.severity),
            category: this.validateCategory(c.category),
            suggestion: c.suggestion,
            replacement: c.replacement,
          }))
        : [];

      return {
        issues,
        suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
      };
    } catch (error) {
      // If script output is not valid JSON, create an error result
      return {
        issues: [
          {
            file: 'script',
            line: 0,
            endLine: undefined,
            ruleId: 'script/error',
            message: `Script execution error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            severity: 'error',
            category: 'logic',
            suggestion: undefined,
            replacement: undefined,
          },
        ],
        suggestions: [`Script ${scriptPath} failed to produce valid JSON output`],
      };
    }
  }

  private validateSeverity(severity: string): 'info' | 'warning' | 'error' | 'critical' {
    const valid = ['info', 'warning', 'error', 'critical'];
    return valid.includes(severity)
      ? (severity as 'info' | 'warning' | 'error' | 'critical')
      : 'info';
  }

  private validateCategory(
    category: string
  ): 'security' | 'performance' | 'style' | 'logic' | 'documentation' {
    const valid = ['security', 'performance', 'style', 'logic', 'documentation'];
    return valid.includes(category)
      ? (category as 'security' | 'performance' | 'style' | 'logic' | 'documentation')
      : 'logic';
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'script', 'interpreter', 'timeout', 'workingDirectory', 'env'];
  }

  async isAvailable(): Promise<boolean> {
    // Scripts are always available if the runtime supports child_process
    return true;
  }

  getRequirements(): string[] {
    return [
      'Script file must exist and be executable',
      'Script interpreter must be available (bash, python, node, etc.)',
      'Script must output JSON in ReviewSummary format',
      'Script receives PR info as JSON via stdin',
    ];
  }
}
