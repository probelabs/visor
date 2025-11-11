import { CustomToolDefinition } from '../types/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import Sandbox from '@nyariv/sandboxjs';
import { logger } from '../logger';

/**
 * Executes custom tools defined in YAML configuration
 * These tools can be used in MCP blocks as if they were native MCP tools
 */
export class CustomToolExecutor {
  private liquid: Liquid;
  private sandbox?: Sandbox;
  private tools: Map<string, CustomToolDefinition>;

  constructor(tools?: Record<string, CustomToolDefinition>) {
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
    this.tools = new Map(Object.entries(tools || {}));
  }

  /**
   * Register a custom tool
   */
  registerTool(tool: CustomToolDefinition): void {
    if (!tool.name) {
      throw new Error('Tool must have a name');
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools
   */
  registerTools(tools: Record<string, CustomToolDefinition>): void {
    for (const [name, tool] of Object.entries(tools)) {
      // Ensure tool has the correct name
      tool.name = tool.name || name;
      this.registerTool(tool);
    }
  }

  /**
   * Get all registered tools
   */
  getTools(): CustomToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: string): CustomToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Validate tool input against schema
   */
  private validateInput(tool: CustomToolDefinition, input: Record<string, unknown>): void {
    if (!tool.inputSchema) {
      return;
    }

    const schema = tool.inputSchema;

    // Check required properties
    if (schema.required) {
      for (const prop of schema.required) {
        if (!(prop in input)) {
          throw new Error(`Missing required property: ${prop}`);
        }
      }
    }

    // Check property types (basic validation)
    if (schema.properties) {
      for (const [key] of Object.entries(input)) {
        if (!schema.additionalProperties && !(key in schema.properties)) {
          throw new Error(`Unknown property: ${key}`);
        }
      }
    }
  }

  /**
   * Execute a custom tool
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context?: {
      pr?: {
        number: number;
        title: string;
        author: string;
        branch: string;
        base: string;
      };
      files?: unknown[];
      outputs?: Record<string, unknown>;
      env?: Record<string, string>;
    }
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    // Validate input
    this.validateInput(tool, args);

    // Build template context
    const templateContext = {
      ...context,
      args,
      input: args,
    };

    // Render command with Liquid
    const command = await this.liquid.parseAndRender(tool.exec, templateContext);

    // Render stdin if provided
    let stdin: string | undefined;
    if (tool.stdin) {
      stdin = await this.liquid.parseAndRender(tool.stdin, templateContext);
    }

    // Execute the command
    const result = await this.executeCommand(command, {
      stdin,
      cwd: tool.cwd,
      env: { ...process.env, ...tool.env, ...context?.env } as Record<string, string>,
      timeout: tool.timeout || 30000,
    });

    // Parse JSON if requested
    let output: unknown = result.stdout;
    if (tool.parseJson) {
      try {
        output = JSON.parse(result.stdout);
      } catch (e) {
        logger.warn(`Failed to parse tool output as JSON: ${e}`);
      }
    }

    // Apply transform if specified
    if (tool.transform) {
      const transformContext = {
        ...templateContext,
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
      const transformed = await this.liquid.parseAndRender(tool.transform, transformContext);
      // Try to parse as JSON if it looks like JSON
      if (typeof transformed === 'string' && transformed.trim().startsWith('{')) {
        try {
          output = JSON.parse(transformed);
        } catch {
          output = transformed;
        }
      } else {
        output = transformed;
      }
    }

    // Apply JavaScript transform if specified
    if (tool.transform_js) {
      output = await this.applyJavaScriptTransform(tool.transform_js, output, {
        ...templateContext,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    return output;
  }

  /**
   * Execute a shell command
   */
  private async executeCommand(
    command: string,
    options: {
      stdin?: string;
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
    }
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const execAsync = promisify(exec);

    // If stdin is provided, we need to handle it differently
    if (options.stdin) {
      return new Promise((resolve, reject) => {
        const childProcess = exec(
          command,
          {
            cwd: options.cwd,
            env: options.env as NodeJS.ProcessEnv,
            timeout: options.timeout || 30000,
          },
          (error, stdout, stderr) => {
            if (error && error.killed && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
              reject(new Error(`Command timed out after ${options.timeout || 30000}ms`));
            } else {
              resolve({
                stdout: stdout || '',
                stderr: stderr || '',
                exitCode: error ? error.code || 1 : 0,
              });
            }
          }
        );

        // Write stdin and close
        if (options.stdin) {
          childProcess.stdin?.write(options.stdin);
          childProcess.stdin?.end();
        }
      });
    }

    // For commands without stdin, use the simpler promisified version
    try {
      const result = await execAsync(command, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        timeout: options.timeout || 30000,
      });

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: 0,
      };
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (execError.killed && execError.code === 'ETIMEDOUT') {
        throw new Error(`Command timed out after ${options.timeout || 30000}ms`);
      }

      return {
        stdout: execError.stdout || '',
        stderr: execError.stderr || '',
        exitCode: execError.code ? parseInt(execError.code as string, 10) : 1,
      };
    }
  }

  /**
   * Apply JavaScript transform to output
   */
  private async applyJavaScriptTransform(
    transformJs: string,
    output: unknown,
    context: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.sandbox) {
      this.sandbox = createSecureSandbox();
    }

    const code = `
      const output = ${JSON.stringify(output)};
      const context = ${JSON.stringify(context)};
      const args = context.args || {};
      const pr = context.pr || {};
      const files = context.files || [];
      const outputs = context.outputs || {};
      const env = context.env || {};

      ${transformJs}
    `;

    try {
      return await compileAndRun(this.sandbox, code, { timeout: 5000 });
    } catch (error) {
      logger.error(`JavaScript transform error: ${error}`);
      throw error;
    }
  }

  /**
   * Convert custom tools to MCP tool format
   */
  toMcpTools(): Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      handler: async (args: Record<string, unknown>) => {
        return this.execute(tool.name, args);
      },
    }));
  }
}
