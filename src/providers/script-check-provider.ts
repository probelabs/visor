import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import Sandbox from '@nyariv/sandboxjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import { MemoryStore } from '../memory-store';
import { createSecureSandbox, compileAndRun, compileAndRunAsync } from '../utils/sandbox';
import { buildProviderTemplateContext } from '../utils/template-context';
import { createSyncMemoryOps } from '../utils/script-memory-ops';
import { CustomToolDefinition, McpServerConfig } from '../types/config';
import { resolveTools } from '../utils/tool-resolver';
import {
  buildToolGlobals,
  buildBuiltinGlobals,
  transformScriptForAsync,
  McpClientEntry,
} from '../utils/script-tool-environment';
import {
  WorkflowToolReference,
  isWorkflowToolReference,
  WorkflowToolContext,
} from './workflow-tool-executor';
import { EnvironmentResolver } from '../utils/env-resolver';

/**
 * Provider that executes JavaScript in a secure sandbox using
 * a first-class step: `type: 'script'` + `content: | ...`.
 *
 * When `tools`, `tools_js`, or `mcp_servers` are configured, tools are
 * exposed as raw async functions in the sandbox (by name). An AST
 * transformer auto-injects `await` so users write synchronous-looking code.
 */
export class ScriptCheckProvider extends CheckProvider {
  private liquid: ReturnType<typeof createExtendedLiquid>;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false,
    });
  }

  private createSecureSandbox(): Sandbox {
    return createSecureSandbox();
  }

  getName(): string {
    return 'script';
  }

  getDescription(): string {
    return 'Execute JavaScript with access to PR context, dependency outputs, memory, and tools.';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') return false;
    const cfg = config as CheckProviderConfig & { content?: string };
    if (typeof cfg.content !== 'string') return false;
    const trimmed = cfg.content.trim();
    if (trimmed.length === 0) return false;
    try {
      const bytes = Buffer.byteLength(cfg.content, 'utf8');
      if (bytes > 1024 * 1024) return false; // 1MB cap
    } catch {}
    if (cfg.content.indexOf('\u0000') >= 0) return false;
    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig & { content?: string },
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: {
      parentSessionId?: string;
      reuseSession?: boolean;
    } & ExecutionContext
  ): Promise<ReviewSummary> {
    // Test hook: mock output for this step (short-circuit execution)
    try {
      const stepName = (config as any).checkName || 'unknown';
      const mock = _sessionInfo?.hooks?.mockForStep?.(String(stepName));
      if (mock !== undefined) {
        return { issues: [], output: mock } as ReviewSummary & { output: unknown };
      }
    } catch {}

    const script = String(config.content || '');
    const memoryStore = MemoryStore.getInstance();
    const ctx = buildProviderTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      (config as any).__outputHistory as Map<string, unknown[]> | undefined,
      (_sessionInfo as any)?.stageHistoryBase as Record<string, number> | undefined,
      { attachMemoryReadHelpers: false, args: _sessionInfo?.args }
    );

    // Add workflow inputs to the context
    const inputs = (config as any).workflowInputs || _sessionInfo?.workflowInputs || {};
    (ctx as any).inputs = inputs;

    // Add environment variables to context
    (ctx as any).env = process.env;

    // Attach synchronous memory ops
    const { ops, needsSave } = createSyncMemoryOps(memoryStore);
    (ctx as any).memory = ops as unknown as Record<string, unknown>;

    // Add helper functions to the context
    (ctx as any).escapeXml = (str: unknown): string => {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };
    (ctx as any).btoa = (str: unknown): string => {
      return Buffer.from(String(str), 'binary').toString('base64');
    };
    (ctx as any).atob = (str: unknown): string => {
      return Buffer.from(String(str), 'base64').toString('binary');
    };

    // Build built-in globals (schedule, fetch, github, bash)
    const { globals: builtinGlobals, asyncFunctionNames: builtinAsyncNames } = buildBuiltinGlobals({
      config: config as Record<string, unknown>,
      prInfo: prInfo as any,
      sessionInfo: _sessionInfo as Record<string, unknown>,
    });
    Object.assign(ctx, builtinGlobals);

    // Check if user-configured tools are present
    const hasTools =
      Array.isArray((config as any).tools) ||
      (config as any).tools_js ||
      (config as any).mcp_servers;

    const sandbox = this.createSecureSandbox();
    let result: unknown;
    let mcpClients: McpClientEntry[] = [];

    try {
      // Collect all async function names (builtins + user tools)
      const asyncFunctionNames = new Set(builtinAsyncNames);

      if (hasTools) {
        // Resolve user-configured tools
        const toolItems = this.resolveToolItems(config, prInfo, dependencyResults, ctx);
        const globalTools = (config as any).__globalTools as
          | Record<string, CustomToolDefinition>
          | undefined;
        const resolvedTools = resolveTools(toolItems, globalTools, '[script]');

        // Discover MCP tools (connect to servers, call tools/list)
        mcpClients = await this.connectMcpServers((config as any).mcp_servers);

        // Build tool globals (raw async functions by name)
        const toolContext = {
          pr: (ctx as any).pr,
          files: (ctx as any).files || prInfo.files,
          outputs: (ctx as any).outputs,
          env: process.env as Record<string, string>,
        };
        const parentCtx = (_sessionInfo as any)?._parentContext;
        const workflowContext: WorkflowToolContext = {
          prInfo,
          outputs: dependencyResults,
          executionContext: _sessionInfo as ExecutionContext,
          workspace: parentCtx?.workspace,
        };
        const { globals: toolGlobals, asyncFunctionNames: toolAsyncNames } = buildToolGlobals({
          resolvedTools,
          mcpClients,
          toolContext,
          workflowContext,
        });

        // Merge tool globals and async names
        Object.assign(ctx, toolGlobals);
        for (const name of toolAsyncNames) asyncFunctionNames.add(name);
      }

      // Add loop guard
      let loopIterations = 0;
      const maxLoopIterations = 10000;
      (ctx as any).__checkLoop = () => {
        loopIterations++;
        if (loopIterations > maxLoopIterations) {
          throw new Error(`Loop exceeded maximum of ${maxLoopIterations} iterations`);
        }
      };

      // Build known globals set for linting (all ctx keys = known identifiers)
      const knownGlobals = new Set(Object.keys(ctx));
      for (const name of asyncFunctionNames) knownGlobals.add(name);
      // Add internal helpers that the transformer/sandbox injects
      knownGlobals.add('__checkLoop');
      knownGlobals.add('log');

      // Track gated builtins that are disabled for helpful errors
      const disabledBuiltins = new Map<string, string>();
      if (!(config as any).enable_bash) {
        disabledBuiltins.set('bash', "Add 'enable_bash: true' to your check config to enable it.");
      }
      if (!(config as any).enable_fetch) {
        disabledBuiltins.set(
          'fetch',
          "Add 'enable_fetch: true' to your check config to enable it."
        );
      }

      // Transform code (auto-inject await, wrap in async IIFE, lint) and execute
      const transformed = transformScriptForAsync(script, asyncFunctionNames, {
        knownGlobals,
        disabledBuiltins,
      });
      result = await compileAndRunAsync<unknown>(
        sandbox,
        transformed,
        { ...ctx },
        {
          injectLog: true,
          logPrefix: '[script]',
        }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[script] execution error: ${msg}`);
      return {
        issues: [
          {
            file: 'script',
            line: 0,
            ruleId: 'script/execution_error',
            message: msg,
            severity: 'error',
            category: 'logic',
          },
        ],
        output: null,
      } as ReviewSummary;
    } finally {
      // Cleanup MCP connections
      await this.disconnectMcpClients(mcpClients);
    }

    // Persist file-backed memory once if needed
    try {
      if (
        needsSave() &&
        memoryStore.getConfig().storage === 'file' &&
        memoryStore.getConfig().auto_save
      ) {
        await memoryStore.save();
      }
    } catch (e) {
      logger.warn(`[script] memory save failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      if (process.env.VISOR_DEBUG === 'true') {
        const name = String((config as any).checkName || '');
        const t = typeof result;
        console.error(
          `[script-return] ${name} outputType=${t} hasArray=${Array.isArray(result)} hasObj=${
            result && typeof result === 'object'
          }`
        );
      }
    } catch {}
    const out: any = { issues: [], output: result } as ReviewSummary & { output: unknown };
    try {
      (out as any).__histTracked = true;
    } catch {}
    return out;
  }

  /**
   * Resolve tool items from static config and optional JS expression.
   */
  private resolveToolItems(
    config: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    ctx?: Record<string, unknown>
  ): Array<string | WorkflowToolReference> {
    let items: Array<string | WorkflowToolReference> = [];

    // Static tools from config
    const staticTools = (config as any).tools;
    if (Array.isArray(staticTools)) {
      items = staticTools.filter(
        (item: unknown) => typeof item === 'string' || isWorkflowToolReference(item as any)
      ) as Array<string | WorkflowToolReference>;
    }

    // Dynamic tools from JS expression (tools_js)
    const toolsJsExpr = (config as any).tools_js as string | undefined;
    if (toolsJsExpr && dependencyResults) {
      try {
        const jsSandbox = this.createSecureSandbox();
        const jsCtx = ctx || buildProviderTemplateContext(prInfo, dependencyResults);
        (jsCtx as any).env = process.env;
        (jsCtx as any).inputs = (config as any).workflowInputs || {};

        const evalResult = compileAndRun<unknown>(jsSandbox, toolsJsExpr, jsCtx, {
          injectLog: true,
          wrapFunction: true,
          logPrefix: '[tools_js]',
        });

        if (Array.isArray(evalResult)) {
          const dynamic = evalResult.filter(
            (item: unknown) => typeof item === 'string' || isWorkflowToolReference(item as any)
          ) as Array<string | WorkflowToolReference>;

          const existingNames = new Set(items.map(i => (typeof i === 'string' ? i : i.workflow)));
          for (const tool of dynamic) {
            const name = typeof tool === 'string' ? tool : tool.workflow;
            if (!existingNames.has(name)) {
              items.push(tool);
            }
          }
        }
      } catch (error) {
        logger.error(
          `[script] Failed to evaluate tools_js: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }

    return items;
  }

  /**
   * Connect to MCP servers and discover their tools.
   */
  private async connectMcpServers(
    mcpServersConfig?: Record<string, McpServerConfig>
  ): Promise<McpClientEntry[]> {
    if (!mcpServersConfig || Object.keys(mcpServersConfig).length === 0) {
      return [];
    }

    const entries: McpClientEntry[] = [];

    for (const [serverName, serverConfig] of Object.entries(mcpServersConfig)) {
      try {
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

        const client = new Client(
          { name: 'visor-script-client', version: '1.0.0' },
          { capabilities: {} }
        );

        // Resolve env vars
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
          if (value !== undefined) env[key] = value;
        }
        if (serverConfig.env) {
          for (const [key, value] of Object.entries(serverConfig.env)) {
            env[key] = String(EnvironmentResolver.resolveValue(String(value)));
          }
        }

        const timeout = ((serverConfig as any).timeout || 60) * 1000;

        if (serverConfig.command) {
          const { StdioClientTransport } = await import(
            '@modelcontextprotocol/sdk/client/stdio.js'
          );
          const transport = new StdioClientTransport({
            command: serverConfig.command,
            args: serverConfig.args as string[] | undefined,
            env,
            stderr: 'pipe',
          });
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('MCP connection timeout')), timeout)
            ),
          ]);
        } else if (serverConfig.url) {
          const transportType = serverConfig.transport || 'sse';
          if (transportType === 'sse') {
            const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
            await Promise.race([
              client.connect(new SSEClientTransport(new URL(serverConfig.url))),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('MCP connection timeout')), timeout)
              ),
            ]);
          } else {
            const { StreamableHTTPClientTransport } = await import(
              '@modelcontextprotocol/sdk/client/streamableHttp.js'
            );
            await Promise.race([
              client.connect(new StreamableHTTPClientTransport(new URL(serverConfig.url))),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('MCP connection timeout')), timeout)
              ),
            ]);
          }
        } else {
          logger.warn(`[script] MCP server '${serverName}' has no command or url, skipping`);
          continue;
        }

        // Discover tools via tools/list
        let tools: McpClientEntry['tools'] = [];
        try {
          const listResult = await client.listTools();
          tools = (listResult?.tools || []).map((t: any) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }));
          logger.debug(
            `[script] MCP '${serverName}': ${tools.length} tools [${tools.map(t => t.name).join(', ')}]`
          );
        } catch (err) {
          logger.warn(
            `[script] Could not list tools from MCP '${serverName}': ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }

        entries.push({ client, serverName, tools });
      } catch (err) {
        logger.error(
          `[script] Failed to connect MCP '${serverName}': ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    return entries;
  }

  /**
   * Disconnect all MCP clients.
   */
  private async disconnectMcpClients(clients: McpClientEntry[]): Promise<void> {
    for (const entry of clients) {
      try {
        await entry.client.close();
      } catch (err) {
        logger.debug(
          `[script] Error closing MCP '${entry.serverName}': ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'content',
      'tools',
      'tools_js',
      'mcp_servers',
      'enable_fetch',
      'enable_bash',
      'depends_on',
      'group',
      'on',
      'if',
      'fail_if',
      'on_fail',
      'on_success',
      'timeout',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getRequirements(): string[] {
    return ['No external dependencies required'];
  }
}
