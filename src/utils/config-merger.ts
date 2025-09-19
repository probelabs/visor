import { VisorConfig, CheckConfig } from '../types/config';

/**
 * Utility class for merging Visor configurations with proper override semantics
 */
export class ConfigMerger {
  /**
   * Merge two configurations with child overriding parent
   * @param parent - Base configuration
   * @param child - Configuration to merge on top
   * @returns Merged configuration
   */
  public merge(
    parent: Partial<VisorConfig>,
    child: Partial<VisorConfig>
  ): Partial<VisorConfig> {
    // Start with a deep copy of parent
    const result: Partial<VisorConfig> = this.deepCopy(parent);

    // Merge simple properties (child overrides parent)
    if (child.version !== undefined) result.version = child.version;
    if (child.ai_model !== undefined) result.ai_model = child.ai_model;
    if (child.ai_provider !== undefined) result.ai_provider = child.ai_provider;
    if (child.max_parallelism !== undefined) result.max_parallelism = child.max_parallelism;
    if (child.fail_fast !== undefined) result.fail_fast = child.fail_fast;
    if (child.fail_if !== undefined) result.fail_if = child.fail_if;
    if (child.failure_conditions !== undefined) result.failure_conditions = child.failure_conditions;

    // Merge environment variables (deep merge)
    if (child.env) {
      result.env = this.mergeObjects(parent.env || {}, child.env);
    }

    // Merge output configuration (deep merge)
    if (child.output) {
      result.output = this.mergeOutputConfig(parent.output, child.output);
    }

    // Merge checks (special handling)
    if (child.checks) {
      result.checks = this.mergeChecks(parent.checks || {}, child.checks);
    }

    // Note: extends should not be in the final merged config
    // It's only used during the loading process

    return result;
  }

  /**
   * Deep copy an object
   */
  private deepCopy<T>(obj: T): T {
    if (obj === null || obj === undefined) {
      return obj;
    }
    if (obj instanceof Date) {
      return new Date(obj.getTime()) as unknown as T;
    }
    if (obj instanceof Array) {
      const copy: unknown[] = [];
      for (const item of obj) {
        copy.push(this.deepCopy(item));
      }
      return copy as unknown as T;
    }
    if (obj instanceof Object) {
      const copy = {} as Record<string, unknown>;
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          copy[key] = this.deepCopy((obj as any)[key]);
        }
      }
      return copy as T;
    }
    return obj;
  }

  /**
   * Merge two objects (child overrides parent)
   */
  private mergeObjects<T extends Record<string, any>>(
    parent: T,
    child: T
  ): T {
    const result: any = { ...parent };

    for (const key in child) {
      if (Object.prototype.hasOwnProperty.call(child, key)) {
        const parentValue = parent[key];
        const childValue = child[key];

        if (childValue === null || childValue === undefined) {
          // null/undefined in child removes the key
          delete result[key];
        } else if (
          typeof parentValue === 'object' &&
          typeof childValue === 'object' &&
          !Array.isArray(parentValue) &&
          !Array.isArray(childValue) &&
          parentValue !== null &&
          childValue !== null
        ) {
          // Deep merge objects
          result[key] = this.mergeObjects(
            parentValue as Record<string, any>,
            childValue as Record<string, any>
          );
        } else {
          // Child overrides parent (including arrays)
          result[key] = this.deepCopy(childValue);
        }
      }
    }

    return result;
  }

  /**
   * Merge output configurations
   */
  private mergeOutputConfig(
    parent?: Partial<VisorConfig>['output'],
    child?: Partial<VisorConfig>['output']
  ): Partial<VisorConfig>['output'] {
    if (!child) return parent;
    if (!parent) return child;

    const result: any = this.deepCopy(parent);

    // Merge pr_comment
    if (child.pr_comment) {
      result.pr_comment = this.mergeObjects(
        (parent.pr_comment || {}) as Record<string, any>,
        child.pr_comment as Record<string, any>
      ) as any;
    }

    // Merge file_comment
    if (child.file_comment !== undefined) {
      if (child.file_comment === null) {
        delete result.file_comment;
      } else {
        result.file_comment = this.mergeObjects(
          (parent.file_comment || {}) as Record<string, any>,
          child.file_comment as Record<string, any>
        ) as any;
      }
    }

    // Merge github_checks
    if (child.github_checks !== undefined) {
      if (child.github_checks === null) {
        delete result.github_checks;
      } else {
        result.github_checks = this.mergeObjects(
          (parent.github_checks || {}) as Record<string, any>,
          child.github_checks as Record<string, any>
        ) as any;
      }
    }

    return result;
  }

  /**
   * Merge check configurations with special handling
   */
  private mergeChecks(
    parent: Record<string, CheckConfig>,
    child: Record<string, CheckConfig>
  ): Record<string, CheckConfig> {
    const result: Record<string, CheckConfig> = {};

    // Start with all parent checks
    for (const [checkName, checkConfig] of Object.entries(parent)) {
      result[checkName] = this.deepCopy(checkConfig);
    }

    // Process child checks
    for (const [checkName, childConfig] of Object.entries(child)) {
      const parentConfig = parent[checkName];

      if (!parentConfig) {
        // New check, add it
        result[checkName] = this.deepCopy(childConfig);
      } else {
        // Merge existing check
        result[checkName] = this.mergeCheckConfig(parentConfig, childConfig);
      }
    }

    return result;
  }

  /**
   * Merge individual check configurations
   */
  private mergeCheckConfig(
    parent: CheckConfig,
    child: CheckConfig
  ): CheckConfig {
    const result: CheckConfig = this.deepCopy(parent);

    // Simple properties (child overrides parent)
    if (child.type !== undefined) result.type = child.type;
    if (child.prompt !== undefined) result.prompt = child.prompt;
    if (child.exec !== undefined) result.exec = child.exec;
    if (child.stdin !== undefined) result.stdin = child.stdin;
    if (child.url !== undefined) result.url = child.url;
    if (child.focus !== undefined) result.focus = child.focus;
    if (child.command !== undefined) result.command = child.command;
    if (child.ai_model !== undefined) result.ai_model = child.ai_model;
    if (child.ai_provider !== undefined) result.ai_provider = child.ai_provider;
    if (child.group !== undefined) result.group = child.group;
    if (child.schema !== undefined) result.schema = child.schema;
    if (child.if !== undefined) result.if = child.if;
    if (child.reuse_ai_session !== undefined) result.reuse_ai_session = child.reuse_ai_session;
    if (child.fail_if !== undefined) result.fail_if = child.fail_if;
    if (child.failure_conditions !== undefined) result.failure_conditions = child.failure_conditions;

    // Special handling for 'on' array
    if (child.on !== undefined) {
      if (Array.isArray(child.on) && child.on.length === 0) {
        // Empty array disables the check
        result.on = [];
      } else {
        // Replace parent's on array
        result.on = [...child.on];
      }
    }

    // Arrays that get replaced (not concatenated)
    if (child.triggers !== undefined) {
      result.triggers = child.triggers ? [...child.triggers] : undefined;
    }
    if (child.depends_on !== undefined) {
      result.depends_on = child.depends_on ? [...child.depends_on] : undefined;
    }

    // Deep merge objects
    if (child.env) {
      result.env = this.mergeObjects(
        (parent.env || {}) as Record<string, any>,
        child.env as Record<string, any>
      );
    }
    if (child.ai) {
      result.ai = this.mergeObjects(
        (parent.ai || {}) as Record<string, any>,
        child.ai as Record<string, any>
      );
    }
    if (child.template) {
      result.template = this.mergeObjects(
        (parent.template || {}) as Record<string, any>,
        child.template as Record<string, any>
      );
    }

    return result;
  }

  /**
   * Check if a check is disabled (has empty 'on' array)
   */
  public isCheckDisabled(check: CheckConfig): boolean {
    return Array.isArray(check.on) && check.on.length === 0;
  }

  /**
   * Remove disabled checks from the configuration
   */
  public removeDisabledChecks(config: Partial<VisorConfig>): Partial<VisorConfig> {
    if (!config.checks) return config;

    const result = this.deepCopy(config);
    const enabledChecks: Record<string, CheckConfig> = {};

    for (const [checkName, checkConfig] of Object.entries(result.checks!)) {
      if (!this.isCheckDisabled(checkConfig)) {
        enabledChecks[checkName] = checkConfig;
      } else {
        console.log(`ℹ️  Check '${checkName}' is disabled (empty 'on' array)`);
      }
    }

    result.checks = enabledChecks;
    return result;
  }
}