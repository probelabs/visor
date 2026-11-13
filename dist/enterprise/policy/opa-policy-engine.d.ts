/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
import type { PolicyEngine, PolicyConfig, PolicyDecision } from '../../policy/types';
import { type ActorContext, type RepositoryContext, type PullRequestContext } from './policy-input-builder';
/**
 * Enterprise OPA Policy Engine.
 *
 * Wraps both WASM (local) and HTTP (remote) OPA evaluators behind the
 * OSS PolicyEngine interface. All OPA input building and role resolution
 * is handled internally — the OSS call sites pass only plain types.
 */
export declare class OpaPolicyEngine implements PolicyEngine {
    private evaluator;
    private fallback;
    private timeout;
    private config;
    private inputBuilder;
    private logger;
    constructor(config: PolicyConfig);
    initialize(config: PolicyConfig): Promise<void>;
    /**
     * Update actor/repo/PR context (e.g., after PR info becomes available).
     * Called by the enterprise loader when engine context is enriched.
     */
    setActorContext(actor: ActorContext, repo?: RepositoryContext, pullRequest?: PullRequestContext): void;
    evaluateCheckExecution(checkId: string, checkConfig: unknown): Promise<PolicyDecision>;
    evaluateToolInvocation(serverName: string, methodName: string, transport?: string): Promise<PolicyDecision>;
    evaluateCapabilities(checkId: string, capabilities: {
        allowEdit?: boolean;
        allowBash?: boolean;
        allowedTools?: string[];
    }): Promise<PolicyDecision>;
    shutdown(): Promise<void>;
    private resolveRulePath;
    private doEvaluate;
    private rawEvaluate;
    /**
     * Navigate nested OPA WASM result tree to reach the specific rule's output.
     * The WASM entrypoint `-e visor` means the result root IS the visor package,
     * so we strip the `visor/` prefix and walk the remaining segments.
     */
    private navigateWasmResult;
    private parseDecision;
}
//# sourceMappingURL=opa-policy-engine.d.ts.map