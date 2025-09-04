import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { CliOptions, CheckType, OutputFormat } from './types/cli';
import { VisorConfig } from './types/config';

export interface GitHubActionInputs {
  'github-token': string;
  owner?: string;
  repo?: string;
  'auto-review'?: string;
  'visor-config-path'?: string;
  'visor-checks'?: string;
}

export interface GitHubContext {
  event_name: string;
  repository?: {
    owner: { login: string };
    name: string;
  };
  event?: {
    comment?: any;
    issue?: any;
    pull_request?: any;
    action?: string;
  };
  payload?: any;
}

export interface ActionCliOutput {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
  cliOutput?: {
    reviewScore?: number;
    issuesFound?: number;
    autoReviewCompleted?: boolean;
  };
}

/**
 * Bridge between GitHub Action and Visor CLI
 */
export class ActionCliBridge {
  private githubToken: string;
  private context: GitHubContext;

  constructor(githubToken: string, context: GitHubContext) {
    this.githubToken = githubToken;
    this.context = context;
  }

  /**
   * Determine if Visor CLI should be used based on inputs
   */
  public shouldUseVisor(inputs: GitHubActionInputs): boolean {
    return !!(inputs['visor-config-path'] || inputs['visor-checks']);
  }

  /**
   * Parse GitHub Action inputs to CLI arguments
   */
  public parseGitHubInputsToCliArgs(inputs: GitHubActionInputs): string[] {
    const args: string[] = [];

    // Add config path if specified
    if (inputs['visor-config-path']) {
      args.push('--config', inputs['visor-config-path']);
    }

    // Add checks if specified
    if (inputs['visor-checks']) {
      const checks = inputs['visor-checks']
        .split(',')
        .map(check => check.trim())
        .filter(check => this.isValidCheck(check));
      
      for (const check of checks) {
        args.push('--check', check);
      }
    }

    // Always use JSON output for programmatic processing
    args.push('--output', 'json');

    return args;
  }

  /**
   * Execute CLI with GitHub context
   */
  public async executeCliWithContext(
    inputs: GitHubActionInputs,
    options: {
      workingDir?: string;
      timeout?: number;
    } = {}
  ): Promise<ActionCliOutput> {
    const { workingDir = process.cwd(), timeout = 300000 } = options; // 5 min timeout

    try {
      const cliArgs = this.parseGitHubInputsToCliArgs(inputs);
      
      // Set up environment variables for CLI
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        GITHUB_TOKEN: this.githubToken,
        GITHUB_EVENT_NAME: this.context.event_name,
        GITHUB_CONTEXT: JSON.stringify(this.context),
        GITHUB_REPOSITORY_OWNER: this.context.repository?.owner.login || inputs.owner || '',
        GITHUB_REPOSITORY: this.context.repository 
          ? `${this.context.repository.owner.login}/${this.context.repository.name}`
          : `${inputs.owner || ''}/${inputs.repo || ''}`,
      };

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
      } else {
        return {
          success: false,
          output: result.output,
          error: result.error,
          exitCode: result.exitCode,
        };
      }
    } catch (error) {
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
  public mergeActionAndCliOutputs(
    actionInputs: GitHubActionInputs,
    cliResult: ActionCliOutput,
    legacyOutputs?: Record<string, string>
  ): Record<string, string> {
    const outputs: Record<string, string> = {
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
  private executeCommand(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    } = {}
  ): Promise<{ output: string; error: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const { cwd, env, timeout = 30000 } = options;
      
      const child: ChildProcess = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      let error = '';
      let timeoutHandle: NodeJS.Timeout | null = null;

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          output += data.toString();
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          error += data.toString();
        });
      }

      child.on('close', (code) => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve({
          output: output.trim(),
          error: error.trim(),
          exitCode: code || 0,
        });
      });

      child.on('error', (err) => {
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
  private parseCliOutput(output: string): ActionCliOutput['cliOutput'] {
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
    } catch (error) {
      console.log('Could not parse CLI output as JSON, using default values');
      return {};
    }
  }

  /**
   * Check if a check type is valid
   */
  private isValidCheck(check: string): check is CheckType {
    const validChecks: CheckType[] = ['performance', 'architecture', 'security', 'style', 'all'];
    return validChecks.includes(check as CheckType);
  }

  /**
   * Create temporary config file from action inputs
   */
  public async createTempConfigFromInputs(
    inputs: GitHubActionInputs,
    options: { workingDir?: string } = {}
  ): Promise<string | null> {
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
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {},
      output: {
        pr_comment: {
          format: 'summary',
          group_by: 'check',
          collapse: true,
        },
      },
    };

    // Map GitHub Action checks to Visor config format
    for (const check of checks) {
      const checkName = `${check}-check`;
      config.checks![checkName] = {
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
      await fs.writeFile(tempConfigPath, yamlContent, 'utf8');
      
      return tempConfigPath;
    } catch (error) {
      console.error('Failed to create temporary config file:', error);
      return null;
    }
  }

  /**
   * Get AI prompt for a specific check type
   */
  private getPromptForCheck(check: CheckType): string {
    const prompts: Record<CheckType, string> = {
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
  public async cleanup(options: { workingDir?: string } = {}): Promise<void> {
    const { workingDir = process.cwd() } = options;
    const tempConfigPath = path.join(workingDir, '.visor-temp.yaml');
    
    try {
      await fs.unlink(tempConfigPath);
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}