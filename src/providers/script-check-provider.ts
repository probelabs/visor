import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';

/**
 * Check provider that executes shell scripts and captures their output
 * Supports JSON parsing and integration with forEach functionality
 */
export class ScriptCheckProvider extends CheckProvider {
  private liquid: Liquid;

  constructor() {
    super();
    this.liquid = new Liquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
  }

  getName(): string {
    return 'script';
  }

  getDescription(): string {
    return 'Execute shell scripts and capture output for processing';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Must have script specified
    if (!cfg.script || typeof cfg.script !== 'string') {
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    const script = config.script as string;
    const transform = config.transform as string | undefined;

    // Prepare template context for Liquid rendering
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base,
      },
      files: prInfo.files,
      fileCount: prInfo.files.length,
      outputs: this.buildOutputContext(dependencyResults),
      env: this.getSafeEnvironmentVariables(),
    };

    try {
      // Render the script with Liquid templates if needed
      let renderedScript = script;
      if (script.includes('{{') || script.includes('{%')) {
        renderedScript = await this.liquid.parseAndRender(script, templateContext);
      }

      // Prepare environment variables - convert all to strings
      const scriptEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          scriptEnv[key] = value;
        }
      }
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          if (value !== undefined && value !== null) {
            scriptEnv[key] = String(value);
          }
        }
      }

      // Execute the script using dynamic import to avoid Jest issues
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout, stderr } = await execAsync(renderedScript, {
        env: scriptEnv,
        timeout: 60000, // 60 second timeout
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      if (stderr && process.env.DEBUG) {
        console.error(`Script stderr: ${stderr}`);
      }

      // Try to parse output as JSON
      let output: unknown = stdout.trim();
      try {
        // Attempt to parse as JSON
        const parsed = JSON.parse(stdout.trim());
        output = parsed;
      } catch {
        // If not JSON, keep as string
        output = stdout.trim();
      }

      // Apply transform if specified
      let finalOutput = output;
      if (transform) {
        try {
          const transformContext = {
            ...templateContext,
            output,
          };
          const rendered = await this.liquid.parseAndRender(transform, transformContext);

          // Try to parse the transformed result as JSON
          try {
            finalOutput = JSON.parse(rendered.trim());
          } catch {
            finalOutput = rendered.trim();
          }
        } catch (error) {
          return {
            issues: [
              {
                file: 'script',
                line: 0,
                ruleId: 'script/transform_error',
                message: `Failed to apply transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Return the output as part of the review summary
      // The output will be available to dependent checks
      return {
        issues: [],
        output: finalOutput,
      } as ReviewSummary;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        issues: [
          {
            file: 'script',
            line: 0,
            ruleId: 'script/execution_error',
            message: `Script execution failed: ${errorMessage}`,
            severity: 'error',
            category: 'logic',
          },
        ],
      };
    }
  }

  private buildOutputContext(
    dependencyResults?: Map<string, ReviewSummary>
  ): Record<string, unknown> {
    if (!dependencyResults) {
      return {};
    }

    const outputs: Record<string, unknown> = {};
    for (const [checkName, result] of dependencyResults) {
      if ((result as any).output !== undefined) {
        outputs[checkName] = (result as any).output;
      } else {
        outputs[checkName] = {
          issueCount: result.issues?.length || 0,
          issues: result.issues || [],
        };
      }
    }
    return outputs;
  }

  private getSafeEnvironmentVariables(): Record<string, string> {
    const safeVars: Record<string, string> = {};
    const allowedPrefixes = ['CI_', 'GITHUB_', 'RUNNER_', 'NODE_', 'npm_', 'PATH', 'HOME', 'USER'];

    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && allowedPrefixes.some(prefix => key.startsWith(prefix))) {
        safeVars[key] = value;
      }
    }

    // Add current working directory
    safeVars['PWD'] = process.cwd();

    return safeVars;
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'script', 'transform', 'env', 'depends_on', 'on', 'if', 'group', 'forEach'];
  }

  async isAvailable(): Promise<boolean> {
    // Script provider is always available as long as we can execute commands
    return true;
  }

  getRequirements(): string[] {
    return [
      'Valid shell script to execute',
      'Shell environment available',
      'Optional: Transform template for processing output',
    ];
  }
}
