import { CustomToolDefinition } from '../types/config';
import { spawn } from 'child_process';
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
      for (const [key, value] of Object.entries(input)) {
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
      pr?: any;
      files?: any[];
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
    const result = await this.executeCommand(
      command,
      {
        stdin,
        cwd: tool.cwd,
        env: { ...process.env, ...tool.env, ...context?.env },
        timeout: tool.timeout || 30000,
      }
    );

    // Parse JSON if requested
    let output = result.stdout;
    if (tool.parseJson) {
      try {
        output = JSON.parse(output);
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
      output = await this.liquid.parseAndRender(tool.transform, transformContext);
    }

    // Apply JavaScript transform if specified
    if (tool.transform_js) {
      output = await this.applyJavaScriptTransform(
        tool.transform_js,
        output,
        {
          ...templateContext,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        }
      );
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
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command.split(/\s+/);

      const childProcess = spawn(cmd, args, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        shell: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Set timeout
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        childProcess.kill('SIGTERM');
      }, options.timeout || 30000);

      // Handle stdout
      childProcess.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      // Handle stderr
      childProcess.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      // Write stdin if provided
      if (options.stdin) {
        childProcess.stdin?.write(options.stdin);
        childProcess.stdin?.end();
      }

      // Handle process exit
      childProcess.on('exit', (code, signal) => {
        clearTimeout(timeoutHandle);

        if (timedOut) {
          reject(new Error(`Command timed out after ${options.timeout}ms`));
        } else if (signal) {
          reject(new Error(`Command terminated by signal: ${signal}`));
        } else {
          resolve({
            stdout,
            stderr,
            exitCode: code || 0,
          });
        }
      });

      // Handle process error
      childProcess.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
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
      return await compileAndRun(this.sandbox, code, 5000);
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