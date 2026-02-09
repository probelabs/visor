/**
 * Workflow check provider - executes reusable workflows as checks
 */

import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { WorkflowRegistry } from '../workflow-registry';
import { WorkflowExecutor } from '../workflow-executor';
import { logger } from '../logger';
import { WorkflowDefinition, WorkflowExecutionContext } from '../types/workflow';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { generateHumanId } from '../utils/human-id';
// eslint-disable-next-line no-restricted-imports -- needed for Liquid type
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * Provider that executes workflows as checks
 */
export class WorkflowCheckProvider extends CheckProvider {
  private registry: WorkflowRegistry;
  private executor: WorkflowExecutor;
  private liquid: Liquid;

  constructor() {
    super();
    this.registry = WorkflowRegistry.getInstance();
    this.executor = new WorkflowExecutor();
    this.liquid = createExtendedLiquid();
  }

  getName(): string {
    return 'workflow';
  }

  getDescription(): string {
    return 'Executes reusable workflow definitions as checks';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    const cfg = config as CheckProviderConfig & { workflow?: string; config?: string };

    // Two supported modes:
    // 1) workflow: <id> (pre-registered in WorkflowRegistry via imports)
    // 2) config: <path|url> (load a Visor config file and execute its steps as a workflow)
    if (!cfg.workflow && !cfg.config) {
      logger.error('Workflow provider requires either "workflow" (id) or "config" (path)');
      return false;
    }

    // If using workflow id, verify presence in registry now
    if (cfg.workflow) {
      if (!this.registry.has(cfg.workflow as string)) {
        logger.error(`Workflow '${cfg.workflow}' not found in registry`);
        return false;
      }
    }

    // For config path mode we cannot fully validate existence here (no base path);
    // execution will resolve it relative to the parent working directory and fail fast if missing.
    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    const cfg = config as CheckProviderConfig & { workflow?: string; config?: string };
    const isConfigPathMode = !!cfg.config && !cfg.workflow;
    const stepName = (config as any).checkName || cfg.workflow || cfg.config || 'workflow';

    // Resolve workflow definition FIRST (needed for input preparation and validation)
    let workflow: WorkflowDefinition | undefined;
    let workflowId = cfg.workflow as string | undefined;

    if (isConfigPathMode) {
      // Use originalWorkingDirectory for config file resolution - workflow configs
      // should be loaded from the original project path, not the sandbox
      const parentCwd = ((context as any)?._parentContext?.originalWorkingDirectory ||
        (context as any)?._parentContext?.workingDirectory ||
        (context as any)?.originalWorkingDirectory ||
        (context as any)?.workingDirectory ||
        process.cwd()) as string;
      workflow = await this.loadWorkflowFromConfigPath(String(cfg.config), parentCwd);
      workflowId = workflow.id;
      logger.info(`Executing workflow from config '${cfg.config}' as '${workflowId}'`);
    } else {
      workflowId = String(cfg.workflow);
      workflow = this.registry.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow '${workflowId}' not found in registry`);
      }
      logger.info(`Executing workflow '${workflowId}'`);
    }

    // Prepare inputs - do this BEFORE mock check so we can validate inputs even when mocked
    // This allows tests to assert that the correct inputs were passed to workflow steps
    const inputs = await this.prepareInputs(workflow, config, prInfo, dependencyResults);

    // Capture resolved workflow inputs for testing assertions (reuse prompt capture infrastructure)
    // This allows using `prompts` assertions with `provider: 'workflow'` to verify inputs
    try {
      // Serialize inputs to capture for assertions - specifically the context field
      // which contains the rendered template with dependency outputs
      const inputsCapture = Object.entries(inputs)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n\n');
      (context as any)?.hooks?.onPromptCaptured?.({
        step: String(stepName),
        provider: 'workflow',
        prompt: inputsCapture,
      });
    } catch {
      // Ignore capture errors - this is only for testing
    }

    // Validate inputs
    const validation = this.registry.validateInputs(workflow, inputs);
    if (!validation.valid) {
      const errors = validation.errors?.map(e => `${e.path}: ${e.message}`).join(', ');
      throw new Error(`Invalid workflow inputs: ${errors}`);
    }

    // Test harness support: allow mocking workflow checks as a black box.
    // If a mock is provided for this step, short-circuit nested execution and
    // return a ReviewSummary with optional output field.
    // NOTE: This happens AFTER input preparation/validation so tests can assert inputs are correct
    try {
      // test-runner passes hooks on execution context
      const mock = (context as any)?.hooks?.mockForStep?.(String(stepName));
      if (mock !== undefined) {
        const ms = mock as any;
        const issuesArr = Array.isArray(ms?.issues) ? (ms.issues as any[]) : [];
        // Prefer explicit output if provided; otherwise treat the mock object itself as output
        const out = ms && typeof ms === 'object' && 'output' in ms ? ms.output : ms;
        const summary: ReviewSummary & { output?: unknown } = {
          issues: issuesArr,
          output: out,
          ...(typeof ms?.content === 'string' ? { content: String(ms.content) } : {}),
        } as any;
        return summary;
      }
    } catch {}

    // Apply overrides to workflow steps if specified
    const modifiedWorkflow = this.applyOverrides(workflow, config);

    // M3: Check if we're in state-machine mode and should delegate to engine
    const engineMode = (context as any)?._engineMode;
    if (engineMode === 'state-machine') {
      // Delegate to state machine engine for nested workflow execution
      logger.info(`[WorkflowProvider] Delegating workflow '${workflowId}' to state machine engine`);
      return await this.executeViaStateMachine(
        modifiedWorkflow,
        inputs,
        config,
        prInfo,
        dependencyResults,
        context
      );
    }

    // Legacy mode: Execute the workflow using WorkflowExecutor
    const executionContext: WorkflowExecutionContext = {
      instanceId: `${workflowId}-${Date.now()}`,
      parentCheckId: config.checkName,
      inputs,
      stepResults: new Map(),
    };

    const result = await this.executor.execute(modifiedWorkflow, executionContext, {
      prInfo,
      dependencyResults,
      context,
    });

    // Map outputs
    const outputs = this.mapOutputs(result, config.output_mapping as Record<string, string>);

    // Return the review summary with extended fields
    // Note: These extra fields are used by the execution engine but not part of the base interface
    const summary: ReviewSummary = {
      issues: result.issues || [],
    };

    // Add extended fields as needed by the engine
    (summary as any).score = result.score || 0;
    (summary as any).confidence = result.confidence || 'medium';
    (summary as any).comments = result.comments || [];
    (summary as any).output = outputs;
    (summary as any).content = this.formatWorkflowResult(workflow, result, outputs);

    return summary;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'workflow',
      'config',
      'args',
      'overrides',
      'output_mapping',
      'timeout',
      'env',
      'checkName',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true; // Always available
  }

  getRequirements(): string[] {
    return [];
  }

  /**
   * Prepare inputs for workflow execution
   */
  private async prepareInputs(
    workflow: WorkflowDefinition,
    config: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>
  ): Promise<Record<string, unknown>> {
    const inputs: Record<string, unknown> = {};

    // Start with default values from workflow definition
    if (workflow.inputs) {
      for (const param of workflow.inputs) {
        if (param.default !== undefined) {
          inputs[param.name] = param.default;
        }
      }
    }

    // Extract eventContext for slack/conversation
    const eventContext = config.eventContext || {};

    // Debug logging for conversation context
    logger.debug(`[WorkflowProvider] prepareInputs for ${workflow.id}`);
    logger.debug(
      `[WorkflowProvider] eventContext keys: ${Object.keys(eventContext).join(', ') || 'none'}`
    );
    logger.debug(
      `[WorkflowProvider] eventContext.slack: ${eventContext.slack ? 'present' : 'absent'}`
    );
    logger.debug(
      `[WorkflowProvider] eventContext.conversation: ${(eventContext as any).conversation ? 'present' : 'absent'}`
    );

    // Extract slack context (if provided via eventContext.slack)
    const slack = (() => {
      try {
        const anyCtx = eventContext as any;
        const slackCtx = anyCtx?.slack;
        if (slackCtx && typeof slackCtx === 'object') return slackCtx;
      } catch {
        // ignore
      }
      return undefined;
    })();

    // Extract unified conversation context across transports (Slack & GitHub)
    const conversation = (() => {
      try {
        const anyCtx = eventContext as any;
        if (anyCtx?.slack?.conversation) return anyCtx.slack.conversation;
        if (anyCtx?.github?.conversation) return anyCtx.github.conversation;
        if (anyCtx?.conversation) return anyCtx.conversation;
      } catch {
        // ignore
      }
      return undefined;
    })();

    // Debug logging for extracted context
    logger.debug(`[WorkflowProvider] slack extracted: ${slack ? 'present' : 'absent'}`);
    logger.debug(
      `[WorkflowProvider] conversation extracted: ${conversation ? 'present' : 'absent'}`
    );
    if (conversation) {
      logger.debug(
        `[WorkflowProvider] conversation.messages count: ${Array.isArray((conversation as any).messages) ? (conversation as any).messages.length : 0}`
      );
    }

    // Extract output history from config (passed via __outputHistory)
    const outputHistory = (config as any).__outputHistory as Map<string, unknown[]> | undefined;
    const outputs_history: Record<string, unknown[]> = {};
    if (outputHistory) {
      for (const [k, v] of outputHistory.entries()) {
        outputs_history[k] = v;
      }
    }

    // Build template context with all available data
    // Extract .output from each dependency result so that outputs['step-name'].field works naturally
    // (not outputs['step-name'].output.field)
    const outputsMap: Record<string, unknown> = {};
    logger.debug(
      `[WorkflowProvider] dependencyResults: ${dependencyResults ? dependencyResults.size : 'undefined'} entries`
    );
    if (dependencyResults) {
      for (const [key, result] of dependencyResults.entries()) {
        // Extract the output property, or use the whole result if output is undefined
        const extracted = (result as any).output ?? result;
        outputsMap[key] = extracted;
        // Debug: log what we extracted for each dependency
        const extractedKeys =
          extracted && typeof extracted === 'object'
            ? Object.keys(extracted).join(', ')
            : 'not-object';
        logger.debug(`[WorkflowProvider] outputs['${key}']: keys=[${extractedKeys}]`);
      }
    }
    // Get parent workflow inputs from config (for nested workflow template access)
    const parentInputs = (config as any).workflowInputs || {};

    // Get base path for loadConfig helper - resolve relative paths from workflow's directory
    const basePath =
      (config as any).basePath ||
      (config as any)._parentContext?.originalWorkingDirectory ||
      (config as any)._parentContext?.workingDirectory ||
      process.cwd();

    // Create a Liquid engine for loadConfig that supports {% readfile %} with basePath
    const loadConfigLiquid = createExtendedLiquid();

    // loadConfig helper - synchronously reads, renders Liquid templates, and parses YAML/JSON
    // Usage in expressions: loadConfig('config/intents.yaml')
    // Supports {% readfile "path" %} directives that resolve relative to the config file's directory
    const loadConfig = (filePath: string): unknown => {
      try {
        const resolvedPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(basePath, filePath);
        // Get the directory of the config file for resolving relative paths in {% readfile %}
        const configDir = path.dirname(resolvedPath);
        // Use sync read for sandbox expression context (expressions can't be async)
        const rawContent = require('fs').readFileSync(resolvedPath, 'utf-8');
        // Render Liquid templates (e.g., {% readfile "docs/file.md" %}) with basePath context
        // This allows {% readfile %} to resolve paths relative to the config file's directory
        const renderedContent = loadConfigLiquid.parseAndRenderSync(rawContent, {
          basePath: configDir,
        });
        // Parse as YAML (handles JSON too since YAML is a superset of JSON)
        return yaml.load(renderedContent);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[WorkflowProvider] loadConfig failed for '${filePath}': ${msg}`);
        throw new Error(`loadConfig('${filePath}') failed: ${msg}`);
      }
    };

    const templateContext = {
      pr: prInfo,
      outputs: outputsMap,
      env: process.env,
      slack,
      conversation,
      outputs_history,
      // Include parent workflow inputs for templates like {{ inputs.question }}
      inputs: parentInputs,
      // Helper to load external YAML/JSON config files
      loadConfig,
    };

    // Apply user-provided inputs (args)
    const userInputs = config.args || config.workflow_inputs; // Support both for compatibility
    if (userInputs) {
      for (const [key, value] of Object.entries(userInputs)) {
        // Process value if it's a template or expression
        if (typeof value === 'string') {
          // Check if it's a Liquid template
          if (value.includes('{{') || value.includes('{%')) {
            inputs[key] = await this.liquid.parseAndRender(value, templateContext);
            // Debug: log rendered template value for important inputs
            if (key === 'text' || key === 'question' || key === 'context') {
              const rendered = String(inputs[key]);
              logger.info(
                `[WorkflowProvider] Rendered '${key}' input (${rendered.length} chars): ${rendered.substring(0, 500)}${rendered.length > 500 ? '...' : ''}`
              );
            }
          } else {
            inputs[key] = value;
          }
        } else if (typeof value === 'object' && value !== null && 'expression' in value) {
          // JavaScript expression
          const exprValue = value as { expression: string };
          const sandbox = createSecureSandbox();
          inputs[key] = compileAndRun(sandbox, exprValue.expression, templateContext, {
            injectLog: true,
            logPrefix: `workflow.input.${key}`,
          });
        } else {
          inputs[key] = value;
          // Debug: log non-string inputs like arrays
          if (Array.isArray(value)) {
            logger.debug(`[WorkflowProvider] Input '${key}' is array with ${value.length} items`);
          } else if (typeof value === 'object') {
            logger.debug(
              `[WorkflowProvider] Input '${key}' is object with keys: ${Object.keys(value).join(', ')}`
            );
          }
        }
      }
    }

    // Debug: log all input keys and types for troubleshooting
    const inputSummary = Object.entries(inputs)
      .map(([k, v]) => `${k}:${Array.isArray(v) ? `array[${v.length}]` : typeof v}`)
      .join(', ');
    logger.debug(`[WorkflowProvider] Final inputs: ${inputSummary}`);

    return inputs;
  }

  /**
   * Apply overrides to workflow steps
   */
  private applyOverrides(
    workflow: WorkflowDefinition,
    config: CheckProviderConfig
  ): WorkflowDefinition {
    const overrideConfig = config.overrides || config.workflow_overrides; // Support both for compatibility
    if (!overrideConfig) {
      return workflow;
    }

    // Deep clone the workflow
    const modified = JSON.parse(JSON.stringify(workflow));

    // Apply overrides
    for (const [stepId, overrides] of Object.entries(overrideConfig)) {
      if (modified.steps[stepId]) {
        // Merge overrides with existing step config
        modified.steps[stepId] = {
          ...modified.steps[stepId],
          ...overrides,
        };
      } else {
        logger.warn(`Cannot override non-existent step '${stepId}' in workflow '${workflow.id}'`);
      }
    }

    return modified;
  }

  /**
   * Map workflow outputs to check outputs
   */
  private mapOutputs(result: any, outputMapping?: Record<string, string>): Record<string, unknown> {
    if (!outputMapping) {
      return result.output || {};
    }

    const mapped: Record<string, unknown> = {};
    const workflowOutputs = result.output || {};

    for (const [checkOutput, workflowOutput] of Object.entries(outputMapping)) {
      if (workflowOutput in workflowOutputs) {
        mapped[checkOutput] = workflowOutputs[workflowOutput];
      } else if (workflowOutput.includes('.')) {
        // Handle nested paths
        const parts = workflowOutput.split('.');
        let value = workflowOutputs;
        for (const part of parts) {
          value = value?.[part];
          if (value === undefined) break;
        }
        mapped[checkOutput] = value;
      }
    }

    return mapped;
  }

  /**
   * Format workflow execution result for display
   */
  /**
   * Execute workflow via state machine engine (M3: nested workflows)
   */
  private async executeViaStateMachine(
    workflow: WorkflowDefinition,
    inputs: Record<string, unknown>,
    config: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    // Import state machine components
    const {
      projectWorkflowToGraph,
      validateWorkflowDepth,
    } = require('../state-machine/workflow-projection');
    const { StateMachineRunner } = require('../state-machine/runner');
    const { ExecutionJournal } = require('../snapshot-store');
    const { MemoryStore } = require('../memory-store');

    // Extract parent context if available
    const parentContext = (context as any)?._parentContext;
    const parentState = (context as any)?._parentState;

    // Validate workflow depth
    const currentDepth = parentState?.flags?.currentWorkflowDepth || 0;
    // Prefer parent state's configured limit; fall back to config.limits if present; else default 3
    const maxDepth =
      parentState?.flags?.maxWorkflowDepth ??
      parentContext?.config?.limits?.max_workflow_depth ??
      3;
    validateWorkflowDepth(currentDepth, maxDepth, workflow.id);

    // Project workflow to dependency graph
    const { config: workflowConfig, checks: checksMetadata } = projectWorkflowToGraph(
      workflow,
      inputs,
      config.checkName || workflow.id
    );

    // Build isolated child engine context (separate journal/memory to avoid state contamination)
    // Reuse parent's memory config if available, but never the instance
    const parentMemoryCfg =
      (parentContext?.memory &&
        parentContext.memory.getConfig &&
        parentContext.memory.getConfig()) ||
      parentContext?.config?.memory;

    const childJournal = new ExecutionJournal();
    const childMemory = MemoryStore.createIsolated(parentMemoryCfg);
    try {
      await childMemory.initialize();
    } catch {}
    // Enhanced debug logging for workspace propagation diagnosis
    const parentWorkspace = parentContext?.workspace;
    logger.info(`[WorkflowProvider] Workspace propagation for nested workflow '${workflow.id}':`);
    logger.info(`[WorkflowProvider]   parentContext exists: ${!!parentContext}`);
    logger.info(`[WorkflowProvider]   parentContext.workspace exists: ${!!parentWorkspace}`);
    if (parentWorkspace) {
      logger.info(
        `[WorkflowProvider]   parentWorkspace.isEnabled(): ${parentWorkspace.isEnabled?.() ?? 'N/A'}`
      );
      const projectCount = parentWorkspace.listProjects?.()?.length ?? 'N/A';
      logger.info(`[WorkflowProvider]   parentWorkspace project count: ${projectCount}`);
    } else {
      logger.warn(
        `[WorkflowProvider]   NO WORKSPACE from parent - nested checkouts won't be added to workspace!`
      );
    }

    const childContext = {
      mode: 'state-machine' as const,
      config: workflowConfig,
      checks: checksMetadata,
      journal: childJournal,
      memory: childMemory,
      // For nested workflows we continue to execute inside the same logical
      // working directory as the parent run. When workspace isolation is
      // enabled on the parent engine, its WorkspaceManager is also propagated
      // so that nested checks (AI, git-checkout, etc.) see the same isolated
      // workspace and project symlinks instead of falling back to the Visor
      // repository root.
      workingDirectory: parentContext?.workingDirectory || process.cwd(),
      originalWorkingDirectory:
        parentContext?.originalWorkingDirectory || parentContext?.workingDirectory || process.cwd(),
      workspace: parentWorkspace,
      // Always use a fresh session for nested workflows to isolate history
      sessionId: generateHumanId(),
      event: parentContext?.event || prInfo.eventType,
      debug: parentContext?.debug || false,
      maxParallelism: parentContext?.maxParallelism,
      failFast: parentContext?.failFast,
      // Propagate execution hooks (mocks, octokit, etc.) into the child so
      // nested steps can be mocked/observed by the YAML test runner.
      executionContext: (parentContext as any)?.executionContext,
      // Ensure all workflow steps are considered requested to avoid tag/event filtering surprises
      requestedChecks: Object.keys(checksMetadata),
    };

    // Create child runner with inherited context
    const runner = new StateMachineRunner(childContext);
    const childState = runner.getState();

    // Set workflow depth for child
    childState.flags.currentWorkflowDepth = currentDepth + 1;
    childState.flags.maxWorkflowDepth = maxDepth;

    // Set parent references
    childState.parentContext = parentContext;
    childState.parentScope = parentState?.parentScope;

    // Execute the child workflow
    logger.info(
      `[WorkflowProvider] Executing nested workflow '${workflow.id}' at depth ${currentDepth + 1}`
    );
    const result = await runner.run();

    // M3: Check for bubbled events and propagate them to parent
    const bubbledEvents = (childContext as any)._bubbledEvents || [];
    if (bubbledEvents.length > 0 && parentContext) {
      if (parentContext.debug) {
        logger.info(`[WorkflowProvider] Bubbling ${bubbledEvents.length} events to parent context`);
      }

      // Propagate bubbled events to parent
      if (!parentContext._bubbledEvents) {
        (parentContext as any)._bubbledEvents = [];
      }
      (parentContext as any)._bubbledEvents.push(...bubbledEvents);
    }

    // Aggregate results from all workflow steps
    const allIssues: any[] = [];
    let totalScore = 0;
    let scoreCount = 0;

    for (const stepResult of Object.values(result.results)) {
      const typedResult = stepResult as any;
      if (typedResult.issues) {
        allIssues.push(...typedResult.issues);
      }
      if (typedResult.score) {
        totalScore += typedResult.score;
        scoreCount++;
      }
    }

    // Compute workflow outputs
    const outputs = await this.computeWorkflowOutputsFromState(
      workflow,
      inputs,
      result.results,
      prInfo
    );

    // Map outputs if output_mapping is specified
    const mappedOutputs = this.mapOutputs(
      { output: outputs },
      config.output_mapping as Record<string, string>
    );

    // Build aggregated summary
    const summary: ReviewSummary = {
      issues: allIssues,
    };

    (summary as any).score = scoreCount > 0 ? Math.round(totalScore / scoreCount) : 0;
    (summary as any).confidence = 'medium';
    (summary as any).output = mappedOutputs;
    (summary as any).content = this.formatWorkflowResultFromStateMachine(
      workflow,
      result,
      mappedOutputs
    );

    return summary;
  }

  /**
   * Compute workflow outputs from state machine execution results
   */
  private async computeWorkflowOutputsFromState(
    workflow: WorkflowDefinition,
    inputs: Record<string, unknown>,
    groupedResults: Record<string, Array<{ checkName: string; output?: unknown; issues?: any[] }>>,
    prInfo: PRInfo
  ): Promise<Record<string, unknown>> {
    const outputs: Record<string, unknown> = {};

    // Flatten GroupedCheckResults (group -> CheckResult[]) to a simple map
    // of checkName -> { output, issues } so workflow-level value_js can
    // reference outputs["security"].issues, etc.
    const flat: Record<string, { output?: unknown; issues?: any[] }> = {};
    try {
      for (const arr of Object.values(groupedResults || {})) {
        for (const item of arr || []) {
          if (!item) continue;
          const name = (item as any).checkName || (item as any).name;
          if (typeof name === 'string' && name) {
            flat[name] = { output: (item as any).output, issues: (item as any).issues };
          }
        }
      }
    } catch {}

    // Create outputs map that directly exposes .output values (not wrapped in { output, issues })
    // This makes {{ outputs['check-name'] }} work naturally without needing .output
    const outputsMap = Object.fromEntries(
      Object.entries(flat).map(([id, result]) => [id, (result as any).output])
    );

    // If no explicit outputs defined, propagate step outputs automatically
    // This provides a simpler default - no value_js needed for simple passthrough
    if (!workflow.outputs || workflow.outputs.length === 0) {
      const stepNames = Object.keys(outputsMap);

      // For single-step workflows, unwrap the step output to top level
      // This makes { 'step-name': { answer: {...} } } become { answer: {...} }
      if (stepNames.length === 1) {
        const singleStepOutput = outputsMap[stepNames[0]];
        logger.debug(
          `[WorkflowProvider] No outputs defined for workflow '${workflow.id}', unwrapping single step '${stepNames[0]}' output to top level`
        );
        // Return the step's output directly if it's an object, otherwise wrap it
        if (
          singleStepOutput &&
          typeof singleStepOutput === 'object' &&
          !Array.isArray(singleStepOutput)
        ) {
          return singleStepOutput as Record<string, unknown>;
        }
        return { result: singleStepOutput };
      }

      // For multi-step workflows, keep outputs nested by step name
      logger.debug(
        `[WorkflowProvider] No outputs defined for workflow '${workflow.id}', propagating all step outputs: [${stepNames.join(', ')}]`
      );
      return outputsMap;
    }

    // Log available step outputs for debugging
    const stepOutputKeys = Object.keys(outputsMap);
    const stepOutputSummary = stepOutputKeys.map(k => {
      const v = outputsMap[k];
      const keys = v && typeof v === 'object' ? Object.keys(v) : [];
      return `${k}:[${keys.join(',')}]`;
    });
    logger.debug(
      `[WorkflowProvider] Computing outputs for '${workflow.id}'. Available steps: ${stepOutputSummary.join(', ') || '(none)'}`
    );

    for (const output of workflow.outputs) {
      if (output.value_js) {
        // JavaScript expression - wrap in try-catch for graceful degradation
        try {
          const sandbox = createSecureSandbox();
          const result = compileAndRun(
            sandbox,
            output.value_js,
            {
              inputs,
              outputs: outputsMap,
              // Keep 'steps' as alias for backwards compatibility
              steps: outputsMap,
              pr: prInfo,
            },
            { injectLog: true, logPrefix: `workflow.output.${output.name}` }
          );
          outputs[output.name] = result;
          // Log result for debugging
          const resultType =
            result === null ? 'null' : result === undefined ? 'undefined' : typeof result;
          const resultPreview =
            result && typeof result === 'object'
              ? `{${Object.keys(result).join(',')}}`
              : String(result).substring(0, 100);
          logger.debug(
            `[WorkflowProvider] Output '${output.name}' value_js result: type=${resultType}, preview=${resultPreview}`
          );
        } catch (valueJsError) {
          // Log the error but don't crash - set output to null
          const errorMsg =
            valueJsError instanceof Error ? valueJsError.message : String(valueJsError);
          logger.error(
            `[WorkflowProvider] Output '${output.name}' value_js failed: ${errorMsg}. ` +
              `Setting to null. Available step outputs: [${Object.keys(outputsMap).join(', ')}]`
          );
          outputs[output.name] = null;
        }
      } else if (output.value) {
        // Liquid template
        outputs[output.name] = await this.liquid.parseAndRender(output.value, {
          inputs,
          outputs: outputsMap,
          // Keep 'steps' as alias for backwards compatibility
          steps: outputsMap,
          pr: prInfo,
        });
      }
    }

    // Log final outputs
    const outputKeys = Object.keys(outputs);
    const nullOutputs = outputKeys.filter(k => outputs[k] === null || outputs[k] === undefined);
    if (nullOutputs.length > 0) {
      logger.warn(
        `[WorkflowProvider] Workflow '${workflow.id}' has null/undefined outputs: [${nullOutputs.join(', ')}]. ` +
          `This may indicate value_js expressions are not finding expected data.`
      );
    }

    return outputs;
  }

  /**
   * Format workflow result from state machine execution
   */
  private formatWorkflowResultFromStateMachine(
    workflow: WorkflowDefinition,
    result: any,
    outputs: Record<string, unknown>
  ): string {
    const lines: string[] = [];

    lines.push(`Workflow: ${workflow.name}`);
    if (workflow.description) {
      lines.push(`Description: ${workflow.description}`);
    }

    lines.push('');
    lines.push('Execution Summary (State Machine):');
    lines.push(`- Total Steps: ${Object.keys(result.results || {}).length}`);
    lines.push(`- Duration: ${result.statistics?.totalDuration || 0}ms`);

    if (Object.keys(outputs).length > 0) {
      lines.push('');
      lines.push('Outputs:');
      for (const [key, value] of Object.entries(outputs)) {
        const formatted =
          typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        lines.push(`- ${key}: ${formatted}`);
      }
    }

    return lines.join('\n');
  }

  private formatWorkflowResult(
    workflow: WorkflowDefinition,
    result: any,
    outputs: Record<string, unknown>
  ): string {
    const lines: string[] = [];

    lines.push(`Workflow: ${workflow.name}`);
    if (workflow.description) {
      lines.push(`Description: ${workflow.description}`);
    }

    lines.push('');
    lines.push('Execution Summary:');
    lines.push(`- Status: ${result.status || 'completed'}`);
    lines.push(`- Score: ${result.score || 0}`);
    lines.push(`- Issues Found: ${result.issues?.length || 0}`);

    if (result.duration) {
      lines.push(`- Duration: ${result.duration}ms`);
    }

    if (Object.keys(outputs).length > 0) {
      lines.push('');
      lines.push('Outputs:');
      for (const [key, value] of Object.entries(outputs)) {
        const formatted =
          typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        lines.push(`- ${key}: ${formatted}`);
      }
    }

    if (result.stepSummaries && result.stepSummaries.length > 0) {
      lines.push('');
      lines.push('Step Results:');
      for (const summary of result.stepSummaries) {
        lines.push(
          `- ${summary.stepId}: ${summary.status} (${summary.issues?.length || 0} issues)`
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Load a Visor config file (with steps/checks) and wrap it as a WorkflowDefinition
   * so it can be executed by the state machine as a nested workflow.
   */
  private async loadWorkflowFromConfigPath(
    sourcePath: string,
    baseDir: string
  ): Promise<WorkflowDefinition> {
    const path = require('node:path');
    const fs = require('node:fs');
    const yaml = require('js-yaml');
    const resolved = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(baseDir, sourcePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Workflow config not found at: ${resolved}`);
    }

    // First, read raw YAML to check for imports
    const rawContent = fs.readFileSync(resolved, 'utf8');
    const rawData = yaml.load(rawContent) as Record<string, any>;

    // Process imports if present (before loading the full config)
    if (rawData.imports && Array.isArray(rawData.imports)) {
      const configDir = path.dirname(resolved);
      for (const source of rawData.imports) {
        const results = await this.registry.import(source, {
          basePath: configDir,
          validate: true,
        });
        for (const result of results) {
          if (!result.valid && result.errors) {
            // Check if error is just "already exists" - skip silently
            // This allows multiple workflows to import the same dependency
            const isAlreadyExists = result.errors.every((e: any) =>
              e.message.includes('already exists')
            );
            if (isAlreadyExists) {
              logger.debug(`Workflow from '${source}' already imported, skipping`);
              continue;
            }
            const errors = result.errors.map((e: any) => `  ${e.path}: ${e.message}`).join('\n');
            throw new Error(`Failed to import workflow from '${source}':\n${errors}`);
          }
        }
        logger.info(`Imported workflows from: ${source}`);
      }
    }

    const { ConfigManager } = require('../config');
    const mgr = new ConfigManager();
    // Load as-is without merging bundled defaults; keep child config pure
    const loaded = await mgr.loadConfig(resolved, { validate: false, mergeDefaults: false });

    const steps: Record<string, any> = (loaded as any).steps || (loaded as any).checks || {};
    if (!steps || Object.keys(steps).length === 0) {
      throw new Error(`Config '${resolved}' does not contain any steps to execute as a workflow`);
    }

    const id = path.basename(resolved).replace(/\.(ya?ml)$/i, '');
    const name = (loaded as any).name || `Workflow from ${path.basename(resolved)}`;

    const workflowDef: WorkflowDefinition = {
      id,
      name,
      version: (loaded as any).version || '1.0',
      steps,
      description: (loaded as any).description,
      // Inherit optional triggers if present (not required)
      on: (loaded as any).on,
      // Carry over optional inputs/outputs if present so callers can consume them
      inputs: (loaded as any).inputs,
      outputs: (loaded as any).outputs,
    } as WorkflowDefinition;

    return workflowDef;
  }
}
