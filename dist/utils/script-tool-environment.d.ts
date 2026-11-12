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
import { CustomToolDefinition } from '../types/config';
import { WorkflowToolContext } from '../providers/workflow-tool-executor';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
export interface TransformOptions {
    /** All known global names in the sandbox (for linting unknown calls) */
    knownGlobals?: Set<string>;
    /** Gated builtins that exist but are disabled (e.g., bash without enable_bash) */
    disabledBuiltins?: Map<string, string>;
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
export declare function transformScriptForAsync(code: string, asyncFunctionNames: Set<string>, opts?: TransformOptions): string;
export interface McpClientEntry {
    client: Client;
    serverName: string;
    tools: Array<{
        name: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
    }>;
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
export declare function buildToolGlobals(opts: BuildToolGlobalsOptions): ToolGlobalsResult;
export interface BuildBuiltinGlobalsOptions {
    config: Record<string, unknown>;
    prInfo: {
        number?: number;
        [k: string]: unknown;
    };
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
export declare function buildBuiltinGlobals(opts: BuildBuiltinGlobalsOptions): ToolGlobalsResult;
//# sourceMappingURL=script-tool-environment.d.ts.map