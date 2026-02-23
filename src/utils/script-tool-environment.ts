/**
 * Script Tool Environment
 *
 * Bridges tools into the SandboxJS execution environment for script checks.
 * Pattern ported from Probe's execute_plan DSL runtime:
 *
 * 1. Each tool is exposed as a raw async function (by name) in sandbox globals
 * 2. AST transformer auto-injects `await` before async tool calls
 * 3. Code is wrapped in an async IIFE so compileAsync() can handle it
 * 4. Errors are returned as "ERROR: ..." strings (never thrown — SandboxJS
 *    has unreliable try/catch for async errors)
 */

import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { CustomToolDefinition } from '../types/config';
import { CustomToolExecutor } from '../providers/custom-tool-executor';
import {
  isWorkflowTool,
  executeWorkflowAsTool,
  WorkflowToolContext,
} from '../providers/workflow-tool-executor';
import { logger } from '../logger';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

// ─── AST Transformer ───────────────────────────────────────────────────────

export interface TransformOptions {
  /** All known global names in the sandbox (for linting unknown calls) */
  knownGlobals?: Set<string>;
  /** Gated builtins that exist but are disabled (e.g., bash without enable_bash) */
  disabledBuiltins?: Map<string, string>;
}

/**
 * Format a syntax error with a code snippet showing the exact location.
 *
 *   Line 3, Column 12: Unexpected token
 *
 *     2 | const y = 10;
 *   > 3 | const z = @invalid;
 *     |            ^
 *     4 | return z;
 */
function formatSyntaxError(code: string, err: any): string {
  const line: number = err.loc?.line ?? 0;
  const col: number = err.loc?.column ?? 0;
  const baseMsg = err.message?.replace(/\s*\(\d+:\d+\)$/, '') || 'Syntax error';

  if (!line) return `Syntax error: ${baseMsg}`;

  const lines = code.split('\n');
  const snippetLines: string[] = [];
  const start = Math.max(0, line - 2);
  const end = Math.min(lines.length, line + 1);

  for (let i = start; i < end; i++) {
    const lineNum = String(i + 1).padStart(3, ' ');
    if (i === line - 1) {
      snippetLines.push(`  > ${lineNum} | ${lines[i]}`);
      snippetLines.push(`    ${' '.repeat(lineNum.length)} | ${' '.repeat(col)}^`);
    } else {
      snippetLines.push(`    ${lineNum} | ${lines[i]}`);
    }
  }

  return `Syntax error at line ${line}, column ${col}: ${baseMsg}\n\n${snippetLines.join('\n')}`;
}

/**
 * Simple Levenshtein distance for "did you mean?" suggestions.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Transform script code by auto-injecting `await` before async tool calls
 * and wrapping in an async IIFE.
 *
 * Also performs static analysis:
 * - Pretty syntax error messages with code snippets
 * - Warnings for unknown function calls with "did you mean?" suggestions
 * - Errors for calling gated builtins that are disabled
 *
 * Port of Probe's transformer.js. Uses offset-based string insertion
 * (not AST regeneration) to preserve original code structure.
 */
export function transformScriptForAsync(
  code: string,
  asyncFunctionNames: Set<string>,
  opts?: TransformOptions
): string {
  if (asyncFunctionNames.size === 0) {
    // No async functions — just wrap in IIFE like the sync path
    return `return (() => {\n${code}\n})()`;
  }

  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, {
      ecmaVersion: 2022,
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (e: any) {
    throw new Error(formatSyntaxError(code, e));
  }

  // ── Static analysis: lint unknown function calls ──
  if (opts?.knownGlobals) {
    lintUnknownCalls(code, ast, opts.knownGlobals, opts.disabledBuiltins);
  }

  // Collect insertions: { offset, text } sorted by offset descending
  const insertions: Array<{ offset: number; text: string }> = [];

  // Track which arrow/function expressions need to be marked async
  const functionsNeedingAsync = new Set<acorn.Node>();

  // First pass: collect all function scopes with their ranges
  const functionScopes: acorn.Node[] = [];
  walk.full(ast, (node: acorn.Node) => {
    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      functionScopes.push(node);
    }
  });

  // Second pass: find async calls and determine what needs transformation
  walk.full(ast, (node: acorn.Node) => {
    if (node.type !== 'CallExpression') return;

    const calleeName = getCalleeName(node as any);
    if (!calleeName || !asyncFunctionNames.has(calleeName)) return;

    // Insert 'await ' before the call expression
    insertions.push({ offset: node.start, text: 'await ' });

    // Find the enclosing function (if any) and mark it as needing async
    for (const fn of functionScopes) {
      const body = (fn as any).body;
      if (body && body.start <= node.start && body.end >= node.end) {
        functionsNeedingAsync.add(fn);
      }
    }
  });

  // Third pass: if 'map' is called with a callback containing async calls,
  // mark that callback as async
  walk.full(ast, (node: acorn.Node) => {
    if (node.type !== 'CallExpression') return;
    const callNode = node as any;
    const calleeName = getCalleeName(callNode);
    if (calleeName !== 'map' || !callNode.arguments || callNode.arguments.length < 2) return;

    const callback = callNode.arguments[1];
    if (callback.type === 'ArrowFunctionExpression' || callback.type === 'FunctionExpression') {
      let hasAsyncCall = false;
      walk.full(callback, (inner: acorn.Node) => {
        if (inner.type === 'CallExpression') {
          const innerName = getCalleeName(inner as any);
          if (innerName && asyncFunctionNames.has(innerName)) {
            hasAsyncCall = true;
          }
        }
      });
      if (hasAsyncCall) {
        functionsNeedingAsync.add(callback);
      }
    }
  });

  // Fourth pass: inject loop guards
  walk.full(ast, (node: acorn.Node) => {
    if (
      node.type === 'WhileStatement' ||
      node.type === 'ForStatement' ||
      node.type === 'ForOfStatement' ||
      node.type === 'ForInStatement'
    ) {
      const body = (node as any).body;
      if (body && body.type === 'BlockStatement' && body.body && body.body.length > 0) {
        insertions.push({ offset: body.start + 1, text: ' __checkLoop();' });
      }
    }
  });

  // Build insertions for async markers on functions
  for (const fn of functionsNeedingAsync) {
    insertions.push({ offset: fn.start, text: 'async ' });
  }

  // Sort insertions by offset descending (apply from end to preserve offsets)
  insertions.sort((a, b) => b.offset - a.offset);

  // Apply insertions to the source code
  let transformed = code;
  for (const ins of insertions) {
    transformed = transformed.slice(0, ins.offset) + ins.text + transformed.slice(ins.offset);
  }

  // Wrap in async IIFE with return so SandboxJS awaits the result
  return `return (async () => {\n${transformed}\n})()`;
}

/**
 * Extract function name from a CallExpression callee.
 * Handles: `foo()` → 'foo'
 */
function getCalleeName(callExpr: { callee: { type: string; name?: string } }): string | null {
  const callee = callExpr.callee;
  if (callee.type === 'Identifier' && callee.name) {
    return callee.name;
  }
  return null;
}

// JS built-in globals and common identifiers that should not trigger lint warnings
const JS_BUILTINS = new Set([
  // Constructors & types
  'Array',
  'Object',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'BigInt',
  'Proxy',
  'Reflect',
  // Static methods commonly called as functions
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  // Timers
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  // JSON/Math accessed via method calls are on objects, but just in case
  'JSON',
  'Math',
  'console',
  // Node.js globals — sandbox blocks these at runtime with a better error
  'require',
  'process',
  'Buffer',
  'global',
  'globalThis',
  // Common patterns
  'eval',
  'Function',
  'alert',
  'confirm',
  'prompt',
]);

/**
 * Lint script for unknown function calls.
 * Throws an error with helpful messages for:
 * - Gated builtins called without the enable flag
 * - Unknown functions with "did you mean?" suggestions
 */
function lintUnknownCalls(
  _code: string,
  ast: acorn.Node,
  knownGlobals: Set<string>,
  disabledBuiltins?: Map<string, string>
): void {
  // Collect user-declared function names so we don't warn about them
  const declaredFunctions = new Set<string>();
  walk.full(ast, (node: acorn.Node) => {
    if (node.type === 'FunctionDeclaration' && (node as any).id?.name) {
      declaredFunctions.add((node as any).id.name);
    }
    // Also collect variable declarations that are arrow/function expressions
    if (node.type === 'VariableDeclarator' && (node as any).id?.name) {
      const init = (node as any).init;
      if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        declaredFunctions.add((node as any).id.name);
      }
    }
  });

  const warnings: string[] = [];

  walk.full(ast, (node: acorn.Node) => {
    if (node.type !== 'CallExpression') return;

    const name = getCalleeName(node as any);
    if (!name) return; // method call like obj.method() — skip

    // Skip if it's a known global, JS builtin, or user-declared function
    if (knownGlobals.has(name) || JS_BUILTINS.has(name) || declaredFunctions.has(name)) return;

    const loc = (node as any).loc?.start;
    const lineInfo = loc ? ` (line ${loc.line}, column ${loc.column})` : '';

    // Check if it's a gated builtin that's disabled
    if (disabledBuiltins?.has(name)) {
      const hint = disabledBuiltins.get(name)!;
      warnings.push(`'${name}()' is not enabled${lineInfo}. ${hint}`);
      return;
    }

    // Find closest match for "did you mean?"
    const allNames = [...knownGlobals];
    let bestMatch = '';
    let bestDist = Infinity;
    for (const candidate of allNames) {
      const dist = levenshtein(name.toLowerCase(), candidate.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = candidate;
      }
    }

    // Only suggest if the distance is reasonable (≤40% of the longer name)
    const maxLen = Math.max(name.length, bestMatch.length);
    const suggestion = bestDist <= Math.ceil(maxLen * 0.4) ? ` Did you mean '${bestMatch}'?` : '';

    warnings.push(`Unknown function '${name}()'${lineInfo}.${suggestion}`);
  });

  if (warnings.length > 0) {
    throw new Error(`Script lint errors:\n${warnings.map(w => `  - ${w}`).join('\n')}`);
  }
}

// ─── Tool Globals Builder ───────────────────────────────────────────────────

/**
 * Try to parse a string as JSON if it looks like a JSON object or array.
 */
function tryParseJSON(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  const firstChar = text.trimStart()[0];
  if (firstChar === '{' || firstChar === '[') {
    try {
      return JSON.parse(text);
    } catch {
      /* not valid JSON */
    }
  }
  return text;
}

export interface McpClientEntry {
  client: Client;
  serverName: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

export interface BuildToolGlobalsOptions {
  resolvedTools: Map<string, CustomToolDefinition>;
  mcpClients?: McpClientEntry[];
  toolContext: {
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
  };
  workflowContext?: WorkflowToolContext;
}

export interface ToolGlobalsResult {
  globals: Record<string, unknown>;
  asyncFunctionNames: Set<string>;
}

/**
 * Build sandbox globals for tool functions.
 *
 * Each tool is exposed as a raw async function by its name.
 * MCP tools are namespaced as `{serverName}_{toolName}`.
 * Errors are returned as "ERROR: ..." strings (never thrown).
 */
export function buildToolGlobals(opts: BuildToolGlobalsOptions): ToolGlobalsResult {
  const { resolvedTools, mcpClients, toolContext, workflowContext } = opts;

  const globals: Record<string, unknown> = {};
  const asyncFunctionNames = new Set<string>();

  // Separate command/API tools from workflow tools
  const commandTools: Record<string, CustomToolDefinition> = {};
  for (const [name, tool] of resolvedTools) {
    if (!isWorkflowTool(tool)) {
      commandTools[name] = tool;
    }
  }

  // Create a single executor for command/API tools
  const toolExecutor = new CustomToolExecutor(commandTools);

  // All tool info for listTools()
  const allToolInfo: Array<{ name: string; description?: string }> = [];

  // Bridge resolved tools (command, API, workflow)
  for (const [name, tool] of resolvedTools) {
    const toolFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        if (isWorkflowTool(tool)) {
          if (!workflowContext) {
            return `ERROR: Workflow context not available for tool '${name}'`;
          }
          return await executeWorkflowAsTool(
            tool.__workflowId,
            args,
            workflowContext,
            tool.__argsOverrides
          );
        }
        return await toolExecutor.execute(name, args, toolContext);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[script:${name}] Tool error: ${msg}`);
        return `ERROR: ${msg}`;
      }
    };

    globals[name] = toolFn;
    asyncFunctionNames.add(name);
    allToolInfo.push({ name, description: tool.description });
  }

  // Bridge MCP tools (namespaced as serverName_toolName, same as Probe)
  if (mcpClients) {
    for (const entry of mcpClients) {
      for (const mcpTool of entry.tools) {
        const globalName = `${entry.serverName}_${mcpTool.name}`;

        const mcpToolFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
          try {
            const result = await entry.client.callTool({
              name: mcpTool.name,
              arguments: args,
            });
            // Extract text from MCP response envelope
            const content = (result as any)?.content;
            if (Array.isArray(content) && content.length > 0) {
              const text = content[0]?.text;
              if (text !== undefined) {
                return tryParseJSON(text);
              }
            }
            return result;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            logger.warn(`[script:${globalName}] MCP tool error: ${msg}`);
            return `ERROR: ${msg}`;
          }
        };

        globals[globalName] = mcpToolFn;
        asyncFunctionNames.add(globalName);
        allToolInfo.push({ name: globalName, description: mcpTool.description });
      }
    }
  }

  // callTool dispatcher — also async, for users who prefer the generic form
  const callToolFn = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const fn = globals[name];
    if (!fn || typeof fn !== 'function') {
      const available = Array.from(asyncFunctionNames).join(', ');
      return `ERROR: Tool '${name}' not found. Available: ${available}`;
    }
    return (fn as Function)(args);
  };
  globals.callTool = callToolFn;
  asyncFunctionNames.add('callTool');

  // listTools — synchronous, NOT in asyncFunctionNames
  globals.listTools = (): Array<{ name: string; description?: string }> => {
    return [...allToolInfo];
  };

  return { globals, asyncFunctionNames };
}

// ─── Built-in Globals Builder ─────────────────────────────────────────────

export interface BuildBuiltinGlobalsOptions {
  config: Record<string, unknown>;
  prInfo: { number?: number; [k: string]: unknown };
  sessionInfo?: Record<string, unknown>;
}

/**
 * Build built-in async functions for the script sandbox.
 *
 * Always available: schedule()
 * Context-dependent: github() — only when octokit is in eventContext
 * Gated:            fetch() — requires enable_fetch: true
 *                   bash()  — requires enable_bash: true
 */
export function buildBuiltinGlobals(opts: BuildBuiltinGlobalsOptions): ToolGlobalsResult {
  const globals: Record<string, unknown> = {};
  const asyncFunctionNames = new Set<string>();

  // ── schedule() ──
  const scheduleFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
    try {
      const { handleScheduleAction, buildScheduleToolContext } = await import(
        '../scheduler/schedule-tool'
      );
      const { extractSlackContext } = await import('../slack/schedule-tool-handler');

      const parentCtx = (opts.sessionInfo as any)?._parentContext;
      const webhookData = parentCtx?.prInfo?.eventContext?.webhookData;
      const visorCfg = parentCtx?.config;
      const slackContext = webhookData
        ? extractSlackContext(webhookData as Map<string, unknown>)
        : null;
      const availableWorkflows = visorCfg?.checks ? Object.keys(visorCfg.checks) : undefined;
      const permissions = visorCfg?.scheduler?.permissions;

      const context = buildScheduleToolContext(
        {
          slackContext: slackContext || undefined,
          cliContext: slackContext ? undefined : { userId: 'script' },
        },
        availableWorkflows,
        permissions
      );
      return await handleScheduleAction(args as any, context);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[script:schedule] Error: ${msg}`);
      return `ERROR: ${msg}`;
    }
  };
  globals.schedule = scheduleFn;
  asyncFunctionNames.add('schedule');

  // ── fetch() — gated behind enable_fetch ──
  if ((opts.config as any).enable_fetch === true) {
    const fetchFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        const url = String(args.url || '');
        if (!url) return 'ERROR: url is required';
        const method = String(args.method || 'GET');
        const headers = (args.headers || {}) as Record<string, string>;
        const body = args.body != null ? String(args.body) : undefined;
        const timeout = Number(args.timeout) || 30000;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
          const resp = await globalThis.fetch(url, {
            method,
            headers,
            body: method !== 'GET' ? body : undefined,
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          const contentType = resp.headers.get('content-type') || '';
          if (contentType.includes('json')) return await resp.json();
          const text = await resp.text();
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[script:fetch] Error: ${msg}`);
        return `ERROR: ${msg}`;
      }
    };
    globals.fetch = fetchFn;
    asyncFunctionNames.add('fetch');
  }

  // ── github() — only when octokit is available ──
  const octokit = (opts.config as any).eventContext?.octokit;
  if (octokit) {
    const githubFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        const op = String(args.op || '');
        const repoEnv = process.env.GITHUB_REPOSITORY || '';
        let owner = '';
        let repo = '';
        if (repoEnv.includes('/')) {
          [owner, repo] = repoEnv.split('/') as [string, string];
        }
        if (!owner || !repo) {
          const ec = (opts.config as any).eventContext || {};
          owner = owner || ec.repository?.owner?.login || '';
          repo = repo || ec.repository?.name || '';
        }
        const prNumber = opts.prInfo?.number;
        if (!owner || !repo || !prNumber) {
          return 'ERROR: Missing GitHub repo/PR context';
        }

        const values: string[] = Array.isArray(args.values)
          ? args.values.map(String)
          : typeof args.value === 'string'
            ? [args.value]
            : typeof args.values === 'string'
              ? [args.values]
              : [];

        switch (op) {
          case 'labels.add':
            await octokit.rest.issues.addLabels({
              owner,
              repo,
              issue_number: prNumber,
              labels: values,
            });
            return { success: true, op };
          case 'labels.remove':
            for (const name of values) {
              try {
                await octokit.rest.issues.removeLabel({
                  owner,
                  repo,
                  issue_number: prNumber,
                  name,
                });
              } catch {
                /* label may not exist */
              }
            }
            return { success: true, op };
          case 'comment.create':
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: prNumber,
              body: values[0] || '',
            });
            return { success: true, op };
          default:
            return `ERROR: Unknown github op '${op}'. Supported: labels.add, labels.remove, comment.create`;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[script:github] Error: ${msg}`);
        return `ERROR: ${msg}`;
      }
    };
    globals.github = githubFn;
    asyncFunctionNames.add('github');
  }

  // ── bash() — gated behind enable_bash ──
  if ((opts.config as any).enable_bash === true) {
    const bashFn = async (args: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        const { CommandExecutor } = await import('./command-executor');
        const executor = CommandExecutor.getInstance();
        const command = String(args.command || '');
        if (!command) return 'ERROR: command is required';
        return await executor.execute(command, {
          cwd: args.cwd ? String(args.cwd) : undefined,
          env: args.env as Record<string, string> | undefined,
          timeout: Number(args.timeout) || 30000,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[script:bash] Error: ${msg}`);
        return `ERROR: ${msg}`;
      }
    };
    globals.bash = bashFn;
    asyncFunctionNames.add('bash');
  }

  return { globals, asyncFunctionNames };
}
