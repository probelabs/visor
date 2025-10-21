/*
 Thin SDK façade for programmatic use of Visor.
 - No new execution logic; delegates to existing engine and config manager.
 - Dual ESM/CJS bundle via tsup.
*/

import { CheckExecutionEngine } from './check-execution-engine';
import { ConfigManager } from './config';
import type { AnalysisResult } from './output-formatters';
import type { VisorConfig, TagFilter, HumanInputRequest } from './types/config';
import type { ExecutionContext } from './providers/check-provider.interface';

export type { VisorConfig, TagFilter, HumanInputRequest, ExecutionContext };

export interface VisorOptions {
  cwd?: string;
  debug?: boolean;
  maxParallelism?: number;
  failFast?: boolean;
  tagFilter?: TagFilter;
}

export interface RunOptions extends VisorOptions {
  config?: VisorConfig;
  configPath?: string;
  checks?: string[]; // default: all checks from config
  timeoutMs?: number;
  output?: { format?: 'table' | 'json' | 'markdown' | 'sarif' };
  /** Strict mode: treat config warnings (like unknown keys) as errors (default: false) */
  strictValidation?: boolean;
  /** Execution context for providers (CLI message, hooks, etc.) */
  executionContext?: ExecutionContext;
}

/**
 * Load and validate a Visor config.
 * @param configOrPath - Config object, file path, or omit to discover defaults
 * @param options - Validation options
 * @returns Validated config with defaults applied
 */
export async function loadConfig(
  configOrPath?: string | Partial<VisorConfig>,
  options?: { strict?: boolean }
): Promise<VisorConfig> {
  const cm = new ConfigManager();

  // If it's an object, validate and return with defaults
  if (typeof configOrPath === 'object' && configOrPath !== null) {
    cm.validateConfig(configOrPath, options?.strict ?? false);

    // Apply lightweight defaults without expensive file system operations
    const defaultConfig: Partial<VisorConfig> = {
      version: '1.0',
      checks: {},
      max_parallelism: 3,
      fail_fast: false,
    };

    return {
      ...defaultConfig,
      ...configOrPath,
      checks: configOrPath.checks || {},
    } as VisorConfig;
  }

  // If it's a string, load from file
  if (typeof configOrPath === 'string') {
    return cm.loadConfig(configOrPath);
  }

  // Otherwise discover default config file
  return cm.findAndLoadConfig();
}

/** Expand check IDs by including their dependencies (shallow->deep). */
export function resolveChecks(checkIds: string[], config: VisorConfig | undefined): string[] {
  if (!config?.checks) return Array.from(new Set(checkIds));
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const result: string[] = [];

  const dfs = (id: string, stack: string[] = []) => {
    if (resolved.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack, id].join(' -> ');
      throw new Error(`Circular dependency detected involving check: ${id} (path: ${cycle})`);
    }
    visiting.add(id);
    const deps = config.checks![id]?.depends_on || [];
    for (const d of deps) dfs(d, [...stack, id]);
    if (!result.includes(id)) result.push(id);
    visiting.delete(id);
    resolved.add(id);
  };

  for (const id of checkIds) dfs(id);
  return result;
}

/**
 * Run Visor checks programmatically. Returns the same AnalysisResult shape used by the CLI.
 * Thin wrapper around CheckExecutionEngine.executeChecks.
 */
export async function runChecks(opts: RunOptions = {}): Promise<AnalysisResult> {
  const cm = new ConfigManager();
  let config: VisorConfig;

  if (opts.config) {
    // Validate manually constructed config
    // In strict mode, unknown keys are treated as errors
    cm.validateConfig(opts.config, opts.strictValidation ?? false);
    config = opts.config;
  } else if (opts.configPath) {
    config = await cm.loadConfig(opts.configPath);
  } else {
    config = await cm.findAndLoadConfig();
  }

  const checks =
    opts.checks && opts.checks.length > 0
      ? resolveChecks(opts.checks, config)
      : Object.keys(config.checks || {});

  const engine = new CheckExecutionEngine(opts.cwd);

  // Set execution context if provided
  if (opts.executionContext) {
    engine.setExecutionContext(opts.executionContext);
  }

  const result = await engine.executeChecks({
    checks,
    workingDirectory: opts.cwd,
    timeout: opts.timeoutMs,
    maxParallelism: opts.maxParallelism,
    failFast: opts.failFast,
    outputFormat: opts.output?.format,
    config,
    debug: opts.debug,
    tagFilter: opts.tagFilter,
  });

  return result;
}
