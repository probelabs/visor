/**
 * Copyright (c) ProbeLabs. All rights reserved.
 * Licensed under the Elastic License 2.0; you may not use this file except
 * in compliance with the Elastic License 2.0.
 */

import type { PolicyEngine, PolicyConfig, PolicyDecision } from '../../policy/types';
import { OpaWasmEvaluator } from './opa-wasm-evaluator';
import { OpaHttpEvaluator } from './opa-http-evaluator';
import {
  PolicyInputBuilder,
  type ActorContext,
  type RepositoryContext,
} from './policy-input-builder';

/**
 * Enterprise OPA Policy Engine.
 *
 * Wraps both WASM (local) and HTTP (remote) OPA evaluators behind the
 * OSS PolicyEngine interface. All OPA input building and role resolution
 * is handled internally — the OSS call sites pass only plain types.
 */
export class OpaPolicyEngine implements PolicyEngine {
  private evaluator: OpaWasmEvaluator | OpaHttpEvaluator | null = null;
  private fallback: 'allow' | 'deny';
  private timeout: number;
  private config: PolicyConfig;
  private inputBuilder: PolicyInputBuilder | null = null;

  constructor(config: PolicyConfig) {
    this.config = config;
    this.fallback = config.fallback || 'deny';
    this.timeout = config.timeout || 5000;
  }

  async initialize(config: PolicyConfig): Promise<void> {
    this.config = config;
    this.fallback = config.fallback || 'deny';
    this.timeout = config.timeout || 5000;

    // Build actor/repo context from environment (available at engine init time)
    const actor: ActorContext = {
      authorAssociation: process.env.VISOR_AUTHOR_ASSOCIATION,
      login: process.env.VISOR_AUTHOR_LOGIN || process.env.GITHUB_ACTOR,
      isLocalMode: !process.env.GITHUB_ACTIONS,
    };
    const repo: RepositoryContext = {
      owner: process.env.GITHUB_REPOSITORY_OWNER,
      name: process.env.GITHUB_REPOSITORY?.split('/')[1],
      branch: process.env.GITHUB_HEAD_REF,
      baseBranch: process.env.GITHUB_BASE_REF,
      event: process.env.GITHUB_EVENT_NAME,
    };
    this.inputBuilder = new PolicyInputBuilder(config, actor, repo);

    if (config.engine === 'local') {
      if (!config.rules) {
        throw new Error('OPA local mode requires `policy.rules` path to .wasm or .rego files');
      }
      const wasm = new OpaWasmEvaluator();
      await wasm.initialize(config.rules);
      this.evaluator = wasm;
    } else if (config.engine === 'remote') {
      if (!config.url) {
        throw new Error('OPA remote mode requires `policy.url` pointing to OPA server');
      }
      this.evaluator = new OpaHttpEvaluator(config.url, this.timeout);
    } else {
      this.evaluator = null;
    }
  }

  /**
   * Update actor/repo context (e.g., after PR info becomes available).
   * Called by the enterprise loader when engine context is enriched.
   */
  setActorContext(actor: ActorContext, repo?: RepositoryContext): void {
    this.inputBuilder = new PolicyInputBuilder(this.config, actor, repo);
  }

  async evaluateCheckExecution(checkId: string, checkConfig: unknown): Promise<PolicyDecision> {
    if (!this.evaluator || !this.inputBuilder) return { allowed: true };
    const cfg = checkConfig as any;
    const input = this.inputBuilder.forCheckExecution({
      id: checkId,
      type: cfg.type || 'ai',
      group: cfg.group,
      tags: cfg.tags,
      criticality: cfg.criticality,
      sandbox: cfg.sandbox,
      policy: cfg.policy,
    });
    return this.doEvaluate(input, this.resolveRulePath('check.execute', cfg.policy?.rule));
  }

  async evaluateToolInvocation(
    serverName: string,
    methodName: string,
    transport?: string
  ): Promise<PolicyDecision> {
    if (!this.evaluator || !this.inputBuilder) return { allowed: true };
    const input = this.inputBuilder.forToolInvocation(serverName, methodName, transport);
    return this.doEvaluate(input, 'visor/tool/invoke');
  }

  async evaluateCapabilities(
    checkId: string,
    capabilities: {
      allowEdit?: boolean;
      allowBash?: boolean;
      allowedTools?: string[];
    }
  ): Promise<PolicyDecision> {
    if (!this.evaluator || !this.inputBuilder) return { allowed: true };
    const input = this.inputBuilder.forCapabilityResolve(checkId, capabilities);
    return this.doEvaluate(input, 'visor/capability/resolve');
  }

  async shutdown(): Promise<void> {
    if (this.evaluator && 'shutdown' in this.evaluator) {
      await this.evaluator.shutdown();
    }
    this.evaluator = null;
    this.inputBuilder = null;
  }

  private resolveRulePath(defaultScope: string, override?: string): string {
    if (override) return override;
    return `visor/${defaultScope.replace('.', '/')}`;
  }

  private async doEvaluate(input: object, rulePath: string): Promise<PolicyDecision> {
    try {
      const result = await Promise.race([this.rawEvaluate(input, rulePath), this.timeoutPromise()]);
      return this.parseDecision(result);
    } catch {
      return {
        allowed: this.fallback === 'allow',
        reason: `policy evaluation failed, fallback=${this.fallback}`,
      };
    }
  }

  private async rawEvaluate(input: object, rulePath: string): Promise<any> {
    if (this.evaluator instanceof OpaWasmEvaluator) {
      const result = await this.evaluator.evaluate(input);
      // WASM compiled with `-e visor` entrypoint returns the full visor package tree.
      // Navigate to the specific rule subtree using rulePath segments.
      // e.g., 'visor/check/execute' → result.check.execute
      return this.navigateWasmResult(result, rulePath);
    }
    return (this.evaluator as OpaHttpEvaluator).evaluate(input, rulePath);
  }

  /**
   * Navigate nested OPA WASM result tree to reach the specific rule's output.
   * The WASM entrypoint `-e visor` means the result root IS the visor package,
   * so we strip the `visor/` prefix and walk the remaining segments.
   */
  private navigateWasmResult(result: any, rulePath: string): any {
    if (!result || typeof result !== 'object') return result;
    // Strip the 'visor/' prefix (matches our compilation entrypoint)
    const segments = rulePath.replace(/^visor\//, '').split('/');
    let current = result;
    for (const seg of segments) {
      if (current && typeof current === 'object' && seg in current) {
        current = current[seg];
      } else {
        return undefined; // path not found in result tree
      }
    }
    return current;
  }

  private timeoutPromise(): Promise<never> {
    return new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error('policy evaluation timeout')), this.timeout);
    });
  }

  private parseDecision(result: any): PolicyDecision {
    if (result === undefined || result === null) {
      return {
        allowed: this.fallback === 'allow',
        reason: 'no policy result',
      };
    }

    const allowed = result.allowed !== false;
    const decision: PolicyDecision = {
      allowed,
      reason: result.reason,
    };

    if (result.capabilities) {
      decision.capabilities = result.capabilities;
    }
    if (result.filteredMethods) {
      decision.filteredMethods = result.filteredMethods;
    }
    if (result.redactPatterns) {
      decision.redactPatterns = result.redactPatterns;
    }

    return decision;
  }
}
