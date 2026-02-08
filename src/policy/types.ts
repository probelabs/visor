/**
 * Policy engine types — OSS interface.
 *
 * Core code uses only these types. Enterprise modules implement the
 * PolicyEngine interface and handle all OPA-specific logic internally.
 */

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** When true, the action is allowed but a policy violation was detected (audit/warn mode) */
  warn?: boolean;
  /** For capability.resolve: modified capabilities */
  capabilities?: {
    allowEdit?: boolean;
    allowBash?: boolean;
    allowedTools?: string[];
  };
}

/**
 * Domain-aware policy engine interface.
 *
 * Each method corresponds to an enforcement hook point in the OSS code.
 * Implementations receive plain OSS types and return a PolicyDecision.
 * All OPA input building, role resolution, etc. happens inside the
 * implementation — OSS code never imports enterprise modules.
 */
export interface PolicyEngine {
  /** One-time setup (called during engine init) */
  initialize(config: PolicyConfig): Promise<void>;

  /** Can this check execute? Called after if-condition, before deps. */
  evaluateCheckExecution(checkId: string, checkConfig: unknown): Promise<PolicyDecision>;

  /** Can this MCP method be called? */
  evaluateToolInvocation(
    serverName: string,
    methodName: string,
    transport?: string
  ): Promise<PolicyDecision>;

  /** What AI capabilities should be allowed for this check? */
  evaluateCapabilities(
    checkId: string,
    capabilities: {
      allowEdit?: boolean;
      allowBash?: boolean;
      allowedTools?: string[];
    }
  ): Promise<PolicyDecision>;

  /** Tear down resources */
  shutdown(): Promise<void>;
}

export interface PolicyConfig {
  /** Policy engine mode */
  engine: 'local' | 'remote' | 'disabled';
  /** Path to .rego files or .wasm bundle (local mode) */
  rules?: string | string[];
  /** Path to a JSON file to load as OPA data document */
  data?: string;
  /** OPA server URL (remote mode) */
  url?: string;
  /** Default decision when policy evaluation fails */
  fallback?: 'allow' | 'deny' | 'warn';
  /** Evaluation timeout in ms (default: 5000) */
  timeout?: number;
  /** Role definitions: map role names to conditions */
  roles?: Record<string, PolicyRoleConfig>;
}

export interface PolicyRoleConfig {
  /** GitHub author associations that map to this role */
  author_association?: string[];
  /** GitHub team slugs (requires GitHub API) */
  teams?: string[];
  /** Explicit GitHub usernames */
  users?: string[];
}

export interface StepPolicyOverride {
  /** Required role(s) - any of these roles suffices */
  require?: string | string[];
  /** Explicit deny for roles */
  deny?: string[];
  /** Custom OPA rule path for this step */
  rule?: string;
}
