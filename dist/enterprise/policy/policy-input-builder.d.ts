/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */
import type { PolicyConfig, StepPolicyOverride } from '../../policy/types';
/**
 * OPA input document shape (internal to enterprise code).
 * This mirrors what OPA .rego rules expect — OSS code never sees this type.
 */
export interface OpaInput {
    scope: string;
    check?: {
        id: string;
        type: string;
        group?: string;
        tags?: string[];
        criticality?: string;
        sandbox?: string;
        policy?: StepPolicyOverride;
    };
    tool?: {
        serverName: string;
        methodName: string;
        transport?: string;
    };
    capability?: {
        allowEdit?: boolean;
        allowBash?: boolean;
        allowedTools?: string[];
        enableDelegate?: boolean;
        enableExecutePlan?: boolean;
        sandbox?: string;
    };
    actor: {
        authorAssociation?: string;
        login?: string;
        roles: string[];
        isLocalMode: boolean;
        slack?: {
            userId?: string;
            email?: string;
            channelId?: string;
            channelType?: 'channel' | 'dm' | 'group';
        };
    };
    repository?: {
        owner?: string;
        name?: string;
        branch?: string;
        baseBranch?: string;
        event?: string;
        action?: string;
    };
    pullRequest?: {
        number?: number;
        labels?: string[];
        draft?: boolean;
        changedFiles?: number;
    };
}
export interface ActorContext {
    authorAssociation?: string;
    login?: string;
    isLocalMode: boolean;
    slack?: {
        userId?: string;
        email?: string;
        channelId?: string;
        channelType?: 'channel' | 'dm' | 'group';
    };
}
export interface RepositoryContext {
    owner?: string;
    name?: string;
    branch?: string;
    baseBranch?: string;
    event?: string;
    action?: string;
}
export interface PullRequestContext {
    number?: number;
    labels?: string[];
    draft?: boolean;
    changedFiles?: number;
}
export interface CheckContext {
    id: string;
    type: string;
    group?: string;
    tags?: string[];
    criticality?: string;
    sandbox?: string;
    policy?: StepPolicyOverride;
}
/**
 * Builds OPA-compatible input documents from engine context.
 *
 * Resolves actor roles from the `policy.roles` config section by matching
 * the actor's authorAssociation and login against role definitions.
 */
export declare class PolicyInputBuilder {
    private roles;
    private actor;
    private repository?;
    private pullRequest?;
    constructor(policyConfig: PolicyConfig, actor: ActorContext, repository?: RepositoryContext, pullRequest?: PullRequestContext);
    /** Resolve which roles apply to the current actor. */
    resolveRoles(): string[];
    private buildActor;
    forCheckExecution(check: CheckContext): OpaInput;
    forToolInvocation(serverName: string, methodName: string, transport?: string): OpaInput;
    forCapabilityResolve(checkId: string, capabilities: {
        allowEdit?: boolean;
        allowBash?: boolean;
        allowedTools?: string[];
        enableDelegate?: boolean;
        enableExecutePlan?: boolean;
        sandbox?: string;
    }): OpaInput;
}
//# sourceMappingURL=policy-input-builder.d.ts.map