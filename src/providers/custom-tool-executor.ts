import { CustomToolDefinition } from '../types/config';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import Sandbox from '@nyariv/sandboxjs';
import { logger } from '../logger';
import { commandExecutor } from '../utils/command-executor';
import Ajv from 'ajv';

/**
 * Executes custom tools defined in YAML configuration
 * These tools can be used in MCP blocks as if they were native MCP tools
 */
export class CustomToolExecutor {
  private liquid: Liquid;
  private sandbox?: Sandbox;
  private tools: Map<string, CustomToolDefinition>;
  private ajv: Ajv;

  constructor(tools?: Record<string, CustomToolDefinition>) {
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false,
    });
    this.tools = new Map(Object.entries(tools || {}));
    this.ajv = new Ajv({ allErrors: true, verbose: true });
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
   * Validate tool input against schema using ajv
   */
  private validateInput(tool: CustomToolDefinition, input: Record<string, unknown>): void {
    if (!tool.inputSchema) {
      return;
    }

    // Compile and cache the schema validator for this tool
    const validate = this.ajv.compile(tool.inputSchema);

    // Validate the input
    const valid = validate(input);

    if (!valid) {
      // Format validation errors for better readability
      const errors = validate.errors
        ?.map(err => {
          if (err.instancePath) {
            return `${err.instancePath}: ${err.message}`;
          }
          return err.message;
        })
        .join(', ');

      throw new Error(`Input validation failed for tool '${tool.name}': ${errors}`);
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

    // Execute the command using shared executor
    const env = commandExecutor.buildEnvironment(process.env, tool.env, context?.env);
    const result = await commandExecutor.execute(command, {
      stdin,
      cwd: tool.cwd,
      env,
      timeout: tool.timeout || 30000,
    });

    // Check if command failed (non-zero exit code)
    if (result.exitCode !== 0) {
      const errorOutput = result.stderr || result.stdout || 'Command failed';
      throw new Error(
        `Tool '${toolName}' execution failed with exit code ${result.exitCode}: ${errorOutput}`
      );
    }

    // Parse JSON if requested
    let output: unknown = result.stdout;
    if (tool.parseJson) {
      try {
        output = JSON.parse(result.stdout);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        logger.warn(`Failed to parse tool output as JSON: ${err.message}`);
        // Only throw if there's no transform that might fix it
        if (!tool.transform && !tool.transform_js) {
          throw new Error(`Tool '${toolName}' output could not be parsed as JSON: ${err.message}`);
        }
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
   * Apply JavaScript transform to output
   */
  private async applyJavaScriptTransform(
    transformJs: string,
    output: unknown,
    context: Record<string, unknown>
  ): Promise<unknown> {
    this.sandbox = createSecureSandbox();

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
