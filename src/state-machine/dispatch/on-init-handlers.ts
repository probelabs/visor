/**
 * on_init Invocation Handlers
 *
 * Responsibilities:
 * - Execute tool invocations (from tools: section via MCP)
 * - Execute step invocations (regular checks)
 * - Execute workflow invocations (reusable workflows)
 * - Handle argument passing via 'with' directive
 * - Store outputs with custom names via 'as' directive
 *
 * forEach Integration:
 * - on_init is called ONCE before forEach loops start (in level-dispatch.ts)
 * - Outputs from on_init are shared across all forEach iterations
 * - This allows efficient preprocessing without redundant work per item
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
 * Union type for all invocation types
 */
type OnInitInvocation = OnInitToolInvocation | OnInitStepInvocation | OnInitWorkflowInvocation;

/**
 * Render template expressions in 'with' arguments
 */
async function renderTemplateArguments(
  args: Record<string, unknown> | undefined,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<Record<string, unknown>> {
  const renderedArgs: Record<string, unknown> = {};

  if (!args) {
    return renderedArgs;
  }

  const liquid = createExtendedLiquid();
  for (const [key, value] of Object.entries(args)) {
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

  return renderedArgs;
}

/**
 * Execute a unified on_init invocation (tool, step, or workflow)
 *
 * This function consolidates all invocation types into a single handler that:
 * 1. Determines the invocation type (tool, step, workflow)
 * 2. Renders template arguments
 * 3. Creates appropriate check configuration
 * 4. Executes via the CheckProviderRegistry
 *
 * @param item - Invocation configuration (tool, step, or workflow)
 * @param context - Engine context
 * @param scope - Current forEach scope
 * @param prInfo - PR information for provider execution
 * @param dependencyResults - Dependency outputs from parent check
 * @param executionContext - Execution context
 * @returns Invocation output
 */
async function executeInvocation(
  item: OnInitInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  const CheckProviderRegistry =
    require('../../providers/check-provider-registry').CheckProviderRegistry;
  const providerRegistry = CheckProviderRegistry.getInstance();

  // Render template arguments
  const renderedArgs = await renderTemplateArguments(
    item.with,
    prInfo,
    dependencyResults,
    executionContext
  );

  // Determine invocation type and execute
  if ('tool' in item) {
    // Tool invocation
    const toolName = item.tool;
    const toolDef = context.config.tools?.[toolName];

    if (!toolDef) {
      throw new Error(`Tool '${toolName}' not found in tools: section`);
    }

    logger.info(`[OnInit] Executing tool: ${toolName}`);

    const tempCheckConfig: any = {
      type: 'mcp',
      method: toolName,
      transport: 'custom',
      args: renderedArgs,
    };

    const provider = providerRegistry.getProviderOrThrow('mcp');
    const result = await provider.execute(
      prInfo,
      tempCheckConfig,
      dependencyResults,
      executionContext
    );
    const output = (result as any).output;

    logger.info(`[OnInit] Tool ${toolName} completed`);
    return output;
  } else if ('step' in item) {
    // Step invocation
    const stepName = item.step;
    const stepConfig = context.config.checks?.[stepName];

    if (!stepConfig) {
      throw new Error(`Step '${stepName}' not found in checks: section`);
    }

    logger.info(`[OnInit] Executing step: ${stepName}`);

    // Inject args into execution context
    const enrichedExecutionContext = {
      ...executionContext,
      args: renderedArgs,
    };

    // Get provider for this step's type
    const providerType = stepConfig.type || 'ai';
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
        timeout: stepConfig.ai?.timeout || 1200000,
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
  } else if ('workflow' in item) {
    // Workflow invocation
    const workflowName = item.workflow;

    if (!workflowName) {
      throw new Error('Workflow name is required in on_init workflow invocation');
    }

    logger.info(`[OnInit] Executing workflow: ${workflowName}`);

    const tempCheckConfig: CheckConfig = {
      type: 'workflow',
      workflow: workflowName,
      args: renderedArgs,
      overrides: item.overrides,
      output_mapping: item.output_mapping,
    };

    const provider = providerRegistry.getProviderOrThrow('workflow');
    const result = await provider.execute(
      prInfo,
      tempCheckConfig,
      dependencyResults,
      executionContext
    );
    const output = (result as any).output;

    logger.info(`[OnInit] Workflow ${workflowName} completed`);
    return output;
  }

  throw new Error('Invalid on_init invocation: must specify tool, step, or workflow');
}

/**
 * Execute a tool invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export async function executeToolInvocation(
  item: OnInitToolInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  return executeInvocation(item, context, scope, prInfo, dependencyResults, executionContext);
}

/**
 * Execute a step invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export async function executeStepInvocation(
  item: OnInitStepInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  return executeInvocation(item, context, scope, prInfo, dependencyResults, executionContext);
}

/**
 * Execute a workflow invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export async function executeWorkflowInvocation(
  item: OnInitWorkflowInvocation,
  context: EngineContext,
  scope: Scope,
  prInfo: any,
  dependencyResults: Record<string, unknown>,
  executionContext: any
): Promise<unknown> {
  return executeInvocation(item, context, scope, prInfo, dependencyResults, executionContext);
}
