import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';
import Sandbox from '@nyariv/sandboxjs';

/**
 * Check provider that executes shell commands and captures their output
 * Supports JSON parsing and integration with forEach functionality
 */
export class CommandCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox: Sandbox;

  constructor() {
    super();
    this.liquid = new Liquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
    this.sandbox = this.createSecureSandbox();
  }

  private createSecureSandbox(): Sandbox {
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      console: console,
      JSON: JSON,
    };

    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
    return new Sandbox({ globals, prototypeWhitelist });
  }

  getName(): string {
    return 'command';
  }

  getDescription(): string {
    return 'Execute shell commands and capture output for processing';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Must have exec specified
    if (!cfg.exec || typeof cfg.exec !== 'string') {
      return false;
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<ReviewSummary> {
    const command = config.exec as string;
    const transform = config.transform as string | undefined;
    const transformJs = config.transform_js as string | undefined;

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
      // Render the command with Liquid templates if needed
      let renderedCommand = command;
      if (command.includes('{{') || command.includes('{%')) {
        renderedCommand = await this.liquid.parseAndRender(command, templateContext);
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

      // Get timeout from config (in seconds) or use default (60 seconds)
      const timeoutSeconds = (config.timeout as number) || 60;
      const timeoutMs = timeoutSeconds * 1000;

      const { stdout, stderr } = await execAsync(renderedCommand, {
        env: scriptEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      if (stderr && process.env.DEBUG) {
        console.error(`Command stderr: ${stderr}`);
      }

      // Keep raw output for transforms
      const rawOutput = stdout.trim();

      // Try to parse output as JSON for default behavior
      let output: unknown = rawOutput;
      try {
        // Attempt to parse as JSON
        const parsed = JSON.parse(rawOutput);
        output = parsed;
      } catch {
        // If not JSON, keep as string
        output = rawOutput;
      }

      // Apply transform if specified (Liquid or JavaScript)
      let finalOutput = output;

      // First apply Liquid transform if present
      if (transform) {
        try {
          const transformContext = {
            ...templateContext,
            output: output, // Use parsed output for Liquid (object if JSON, string otherwise)
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
                file: 'command',
                line: 0,
                ruleId: 'command/transform_error',
                message: `Failed to apply Liquid transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Then apply JavaScript transform if present
      if (transformJs) {
        try {
          // For transform_js, always use raw string output so JSON.parse() works as expected
          const jsContext = {
            output: rawOutput, // Always use raw string for JavaScript transform
            pr: templateContext.pr,
            files: templateContext.files,
            outputs: templateContext.outputs,
            env: templateContext.env,
          };

          // Compile and execute the JavaScript expression
          // Use direct property access instead of destructuring to avoid syntax issues
          const code = `
            const output = scope.output;
            const pr = scope.pr;
            const files = scope.files;
            const outputs = scope.outputs;
            const env = scope.env;
            return (${transformJs.trim()});
          `;

          if (process.env.DEBUG) {
            console.log('🔧 Debug: JavaScript transform code:', code);
            console.log('🔧 Debug: JavaScript context:', jsContext);
          }

          const exec = this.sandbox.compile(code);

          finalOutput = exec({ scope: jsContext }).run();

          if (process.env.DEBUG) {
            console.log(
              '🔧 Debug: transform_js result:',
              JSON.stringify(finalOutput).slice(0, 200)
            );
          }
        } catch (error) {
          return {
            issues: [
              {
                file: 'command',
                line: 0,
                ruleId: 'command/transform_js_error',
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : 'Unknown error'}`,
                severity: 'error',
                category: 'logic',
              },
            ],
          };
        }
      }

      // Return the output as part of the review summary
      // The output will be available to dependent checks
      const result = {
        issues: [],
        output: finalOutput,
      } as ReviewSummary;

      if (process.env.DEBUG && transformJs) {
        console.log(
          `🔧 Debug: Command provider returning output:`,
          JSON.stringify((result as any).output).slice(0, 200)
        );
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        issues: [
          {
            file: 'command',
            line: 0,
            ruleId: 'command/execution_error',
            message: `Command execution failed: ${errorMessage}`,
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
      // If the result has a direct output field, use it directly
      // Otherwise, expose the entire result as-is
      outputs[checkName] = (result as any).output !== undefined ? (result as any).output : result;
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
    return [
      'type',
      'exec',
      'transform',
      'transform_js',
      'env',
      'timeout',
      'depends_on',
      'on',
      'if',
      'group',
      'forEach',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Command provider is always available as long as we can execute commands
    return true;
  }

  getRequirements(): string[] {
    return [
      'Valid shell command to execute',
      'Shell environment available',
      'Optional: Transform template for processing output',
    ];
  }
}
