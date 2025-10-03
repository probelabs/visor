/*
 Thin SDK façade for programmatic use of Visor.
 - No new execution logic; delegates to existing engine and config manager.
 - Dual ESM/CJS bundle via tsup.
*/

import { CheckExecutionEngine } from './check-execution-engine';
import { ConfigManager } from './config';
import type { AnalysisResult } from './output-formatters';
import type { VisorConfig, TagFilter } from './types/config';

export type { VisorConfig, TagFilter };

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
}

/** Load a Visor config from path, or discover defaults if path is omitted. */
export async function loadConfig(configPath?: string): Promise<VisorConfig> {
  const cm = new ConfigManager();
  if (configPath) return cm.loadConfig(configPath);
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
    const deps = config.checks[id]?.depends_on || [];
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
  const config: VisorConfig = opts.config
    ? opts.config
    : opts.configPath
      ? await cm.loadConfig(opts.configPath)
      : await cm.findAndLoadConfig();

  const checks =
    opts.checks && opts.checks.length > 0
      ? resolveChecks(opts.checks, config)
      : Object.keys(config.checks || {});

  const engine = new CheckExecutionEngine(opts.cwd);
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
