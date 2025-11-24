/**
 * on_init Invocation Handlers
 *
 * Responsibilities:
 * - Execute tool invocations (from tools: section via MCP)
 * - Execute step invocations (regular checks)
 * - Execute workflow invocations (reusable workflows)
 * - Handle argument passing via 'with' directive
 * - Store outputs with custom names via 'as' directive
 */

import type { EngineContext } from '../../types/engine';
import type {
  OnInitToolInvocation,
  OnInitStepInvocation,
  OnInitWorkflowInvocation,
  CheckConfig,
} from '../../types/config';
import { logger } from '../../logger';
import { createExtendedLiquid } from '../../liquid-extensions';

/**
 * Scope type for forEach context
 */
export type Scope = Array<{ check: string; index: number }>;

/**
 * Execute a tool invocation from on_init.run
 *
 * Creates a temporary MCP check and executes it via the MCP provider.
 * Arguments from 'with' are passed as tool args.
 *
 * @param item - Tool invocation configuration
 * @param context - Engine context
 * @param scope - Current forEach scope
 * @param prInfo - PR information for provider execution
 * @param dependencyResults - Dependency outputs
 * @param executionContext - Execution context
 * @returns Tool output
 */
export async function executeToolInvocation(
  item: OnInitToolInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  const toolName = item.tool;
  const toolDef = context.config.tools?.[toolName];

  if (!toolDef) {
    throw new Error(`Tool '${toolName}' not found in tools: section`);
  }

  logger.info(`[OnInit] Executing tool: ${toolName}`);

  // Render template expressions in 'with' arguments
  const renderedArgs: Record<string, unknown> = {};
  if (item.with) {
    const liquid = createExtendedLiquid();
    for (const [key, value] of Object.entries(item.with)) {
      if (typeof value === 'string') {
        try {
          renderedArgs[key] = await liquid.parseAndRender(value, {
            pr: prInfo,
            outputs: dependencyResults,
            env: process.env,
            args: executionContext.args || {},
          });
        } catch (error) {
          logger.warn(`[OnInit] Failed to render template for ${key}: ${error}`);
          renderedArgs[key] = value;
        }
      } else {
        renderedArgs[key] = value;
      }
    }
  }

  // Create temporary MCP check configuration
  const tempCheckConfig: any = {
    type: 'mcp',
    method: toolName,
    transport: 'custom',
    args: renderedArgs,
  };

  // Get MCP provider and execute
  const CheckProviderRegistry =
    require('../../providers/check-provider-registry').CheckProviderRegistry;
  const providerRegistry = CheckProviderRegistry.getInstance();
  const mcpProvider = providerRegistry.getProviderOrThrow('mcp');

  const result = await mcpProvider.execute(
    prInfo,
    tempCheckConfig,
    dependencyResults,
    executionContext
  );

  const output = (result as any).output;
  logger.info(`[OnInit] Tool ${toolName} completed`);

  return output;
}

/**
 * Execute a step invocation from on_init.run
 *
 * Executes a regular check (from steps: section) with custom arguments.
 * Arguments from 'with' are injected into the execution context as 'args'.
 *
 * @param item - Step invocation configuration
 * @param context - Engine context
 * @param scope - Current forEach scope
 * @param prInfo - PR information for provider execution
 * @param dependencyResults - Dependency outputs
 * @param executionContext - Execution context
 * @returns Step output
 */
export async function executeStepInvocation(
  item: OnInitStepInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  const stepName = item.step;
  const stepConfig = context.config.checks?.[stepName];

  if (!stepConfig) {
    throw new Error(`Step '${stepName}' not found in checks: section`);
  }

  logger.info(`[OnInit] Executing step: ${stepName}`);

  // Render template expressions in 'with' arguments
  const renderedArgs: Record<string, unknown> = {};
  if (item.with) {
    const liquid = createExtendedLiquid();
    for (const [key, value] of Object.entries(item.with)) {
      if (typeof value === 'string') {
        try {
          renderedArgs[key] = await liquid.parseAndRender(value, {
            pr: prInfo,
            outputs: dependencyResults,
            env: process.env,
            args: executionContext.args || {},
          });
        } catch (error) {
          logger.warn(`[OnInit] Failed to render template for ${key}: ${error}`);
          renderedArgs[key] = value;
        }
      } else {
        renderedArgs[key] = value;
      }
    }
  }

  // Inject args into execution context
  const enrichedExecutionContext = {
    ...executionContext,
    args: renderedArgs,
  };

  // Get provider for this step's type
  const providerType = stepConfig.type || 'ai';
  const CheckProviderRegistry =
    require('../../providers/check-provider-registry').CheckProviderRegistry;
  const providerRegistry = CheckProviderRegistry.getInstance();
  const provider = providerRegistry.getProviderOrThrow(providerType);

  // Build output history from journal for template context
  const { buildOutputHistoryFromJournal } = require('./history-snapshot');
  const outputHistory = buildOutputHistoryFromJournal(context);

  // Create provider config
  const providerConfig: any = {
    type: providerType,
    checkName: stepName,
    prompt: stepConfig.prompt,
    exec: stepConfig.exec,
    schema: stepConfig.schema,
    group: stepConfig.group,
    transform: stepConfig.transform,
    transform_js: stepConfig.transform_js,
    env: stepConfig.env,
    ...stepConfig,
    eventContext: (prInfo as any)?.eventContext || {},
    __outputHistory: outputHistory,
    ai: {
      ...(stepConfig.ai || {}),
      timeout: stepConfig.ai?.timeout || 600000,
      debug: !!context.debug,
    },
  };

  const result = await provider.execute(
    prInfo,
    providerConfig,
    dependencyResults,
    enrichedExecutionContext
  );

  const output = (result as any).output;
  logger.info(`[OnInit] Step ${stepName} completed`);

  return output;
}

/**
 * Execute a workflow invocation from on_init.run
 *
 * Executes a reusable workflow with custom inputs.
 * Arguments from 'with' are passed as workflow inputs.
 *
 * @param item - Workflow invocation configuration
 * @param context - Engine context
 * @param scope - Current forEach scope
 * @param prInfo - PR information for provider execution
 * @param dependencyResults - Dependency outputs
 * @param executionContext - Execution context
 * @returns Workflow output
 */
export async function executeWorkflowInvocation(
  item: OnInitWorkflowInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  const workflowName = item.workflow;

  if (!workflowName) {
    throw new Error('Workflow name is required in on_init workflow invocation');
  }

  logger.info(`[OnInit] Executing workflow: ${workflowName}`);

  // Render template expressions in 'with' arguments
  const renderedInputs: Record<string, unknown> = {};
  if (item.with) {
    const liquid = createExtendedLiquid();
    for (const [key, value] of Object.entries(item.with)) {
      if (typeof value === 'string') {
        try {
          renderedInputs[key] = await liquid.parseAndRender(value, {
            pr: prInfo,
            outputs: dependencyResults,
            env: process.env,
            args: executionContext.args || {},
          });
        } catch (error) {
          logger.warn(`[OnInit] Failed to render template for ${key}: ${error}`);
          renderedInputs[key] = value;
        }
      } else {
        renderedInputs[key] = value;
      }
    }
  }

  // Create temporary workflow check configuration
  const tempCheckConfig: CheckConfig = {
    type: 'workflow',
    workflow: workflowName,
    args: renderedInputs,
    overrides: item.overrides,
    output_mapping: item.output_mapping,
  };

  // Get workflow provider and execute
  const CheckProviderRegistry =
    require('../../providers/check-provider-registry').CheckProviderRegistry;
  const providerRegistry = CheckProviderRegistry.getInstance();
  const workflowProvider = providerRegistry.getProviderOrThrow('workflow');

  const result = await workflowProvider.execute(
    prInfo,
    tempCheckConfig,
    dependencyResults,
    executionContext
  );

  const output = (result as any).output;
  logger.info(`[OnInit] Workflow ${workflowName} completed`);

  return output;
}
