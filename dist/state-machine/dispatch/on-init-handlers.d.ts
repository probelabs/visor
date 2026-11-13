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
import type { OnInitToolInvocation, OnInitStepInvocation, OnInitWorkflowInvocation } from '../../types/config';
/**
 * Scope type for forEach context
 */
export type Scope = Array<{
    check: string;
    index: number;
}>;
/**
 * Execute a tool invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export declare function executeToolInvocation(item: OnInitToolInvocation, context: EngineContext, scope: Scope, prInfo: any, dependencyResults: Record<string, unknown>, executionContext: any): Promise<unknown>;
/**
 * Execute a step invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export declare function executeStepInvocation(item: OnInitStepInvocation, context: EngineContext, scope: Scope, prInfo: any, dependencyResults: Record<string, unknown>, executionContext: any): Promise<unknown>;
/**
 * Execute a workflow invocation from on_init.run
 *
 * @deprecated Use executeInvocation instead for better code reuse
 */
export declare function executeWorkflowInvocation(item: OnInitWorkflowInvocation, context: EngineContext, scope: Scope, prInfo: any, dependencyResults: Record<string, unknown>, executionContext: any): Promise<unknown>;
//# sourceMappingURL=on-init-handlers.d.ts.map