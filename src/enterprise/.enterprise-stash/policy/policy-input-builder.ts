/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import type { PolicyConfig, PolicyRoleConfig, StepPolicyOverride } from '../../policy/types';

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
export class PolicyInputBuilder {
  private roles: Record<string, PolicyRoleConfig>;
  private actor: ActorContext;
  private repository?: RepositoryContext;
  private pullRequest?: PullRequestContext;

  constructor(
    policyConfig: PolicyConfig,
    actor: ActorContext,
    repository?: RepositoryContext,
    pullRequest?: PullRequestContext
  ) {
    this.roles = policyConfig.roles || {};
    this.actor = actor;
    this.repository = repository;
    this.pullRequest = pullRequest;
  }

  /** Resolve which roles apply to the current actor. */
  resolveRoles(): string[] {
    const matched: string[] = [];

    for (const [roleName, roleConfig] of Object.entries(this.roles)) {
      let identityMatch = false;

      if (
        roleConfig.author_association &&
        this.actor.authorAssociation &&
        roleConfig.author_association.includes(this.actor.authorAssociation)
      ) {
        identityMatch = true;
      }

      if (
        !identityMatch &&
        roleConfig.users &&
        this.actor.login &&
        roleConfig.users.includes(this.actor.login)
      ) {
        identityMatch = true;
      }

      // Slack user ID match
      if (
        !identityMatch &&
        roleConfig.slack_users &&
        this.actor.slack?.userId &&
        roleConfig.slack_users.includes(this.actor.slack.userId)
      ) {
        identityMatch = true;
      }

      // Email match (case-insensitive)
      if (!identityMatch && roleConfig.emails && this.actor.slack?.email) {
        const actorEmail = this.actor.slack.email.toLowerCase();
        if (roleConfig.emails.some(e => e.toLowerCase() === actorEmail)) {
          identityMatch = true;
        }
      }

      // Note: teams-based role resolution requires GitHub API access (read:org scope)
      // and is not yet implemented. If configured, the role will not match via teams.

      if (!identityMatch) continue;

      // slack_channels gate: if set, the role only applies when triggered from one of these channels
      if (roleConfig.slack_channels && roleConfig.slack_channels.length > 0) {
        if (
          !this.actor.slack?.channelId ||
          !roleConfig.slack_channels.includes(this.actor.slack.channelId)
        ) {
          continue;
        }
      }

      matched.push(roleName);
    }

    return matched;
  }

  private buildActor() {
    return {
      authorAssociation: this.actor.authorAssociation,
      login: this.actor.login,
      roles: this.resolveRoles(),
      isLocalMode: this.actor.isLocalMode,
      ...(this.actor.slack && { slack: this.actor.slack }),
    };
  }

  forCheckExecution(check: CheckContext): OpaInput {
    return {
      scope: 'check.execute',
      check: {
        id: check.id,
        type: check.type,
        group: check.group,
        tags: check.tags,
        criticality: check.criticality,
        sandbox: check.sandbox,
        policy: check.policy,
      },
      actor: this.buildActor(),
      repository: this.repository,
      pullRequest: this.pullRequest,
    };
  }

  forToolInvocation(serverName: string, methodName: string, transport?: string): OpaInput {
    return {
      scope: 'tool.invoke',
      tool: { serverName, methodName, transport },
      actor: this.buildActor(),
      repository: this.repository,
      pullRequest: this.pullRequest,
    };
  }

  forCapabilityResolve(
    checkId: string,
    capabilities: {
      allowEdit?: boolean;
      allowBash?: boolean;
      allowedTools?: string[];
      enableDelegate?: boolean;
      enableExecutePlan?: boolean;
      sandbox?: string;
    }
  ): OpaInput {
    return {
      scope: 'capability.resolve',
      check: { id: checkId, type: 'ai' },
      capability: capabilities,
      actor: this.buildActor(),
      repository: this.repository,
      pullRequest: this.pullRequest,
    };
  }
}
