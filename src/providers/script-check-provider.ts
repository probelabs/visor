import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import Sandbox from '@nyariv/sandboxjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import { MemoryStore } from '../memory-store';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { buildProviderTemplateContext } from '../utils/template-context';
import { createSyncMemoryOps } from '../utils/script-memory-ops';

/**
 * Provider that executes JavaScript in a secure sandbox using
 * a first-class step: `type: 'script'` + `content: | ...`.
 */
export class ScriptCheckProvider extends CheckProvider {
  private liquid: ReturnType<typeof createExtendedLiquid>;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false,
    });
  }

  private createSecureSandbox(): Sandbox {
    return createSecureSandbox();
  }

  getName(): string {
    return 'script';
  }

  getDescription(): string {
    return 'Execute JavaScript with access to PR context, dependency outputs, and memory.';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') return false;
    const cfg = config as CheckProviderConfig & { content?: string };
    if (typeof cfg.content !== 'string') return false;
    const trimmed = cfg.content.trim();
    if (trimmed.length === 0) return false;
    try {
      const bytes = Buffer.byteLength(cfg.content, 'utf8');
      if (bytes > 1024 * 1024) return false; // 1MB cap
    } catch {}
    if (cfg.content.indexOf('\u0000') >= 0) return false;
    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig & { content?: string },
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: {
      parentSessionId?: string;
      reuseSession?: boolean;
    } & import('./check-provider.interface').ExecutionContext
  ): Promise<ReviewSummary> {
    const script = String(config.content || '');
    const memoryStore = MemoryStore.getInstance();
    const ctx = buildProviderTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      (config as any).__outputHistory as Map<string, unknown[]> | undefined,
      (_sessionInfo as any)?.stageHistoryBase as Record<string, number> | undefined,
      { attachMemoryReadHelpers: false }
    );
    // Keep provider quiet by default; no step-specific debug
    // (historical ad-hoc logs removed to avoid hardcoding step names).

    // Attach synchronous memory ops consistent with memory provider
    const { ops, needsSave } = createSyncMemoryOps(memoryStore);
    (ctx as any).memory = ops as unknown as Record<string, unknown>;

    // Evaluate the script in a secure sandbox (per-execution instance)
    const sandbox = this.createSecureSandbox();
    let result: unknown;
    try {
      result = compileAndRun<unknown>(
        sandbox,
        script,
        { ...ctx },
        {
          injectLog: true,
          wrapFunction: true,
          logPrefix: '[script]',
        }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[script] execution error: ${msg}`);
      return {
        issues: [
          {
            file: 'script',
            line: 0,
            ruleId: 'script/execution_error',
            message: msg,
            severity: 'error',
            category: 'logic',
          },
        ],
        output: null,
      } as ReviewSummary;
    }

    // Persist file-backed memory once if needed
    try {
      if (
        needsSave() &&
        memoryStore.getConfig().storage === 'file' &&
        memoryStore.getConfig().auto_save
      ) {
        await memoryStore.save();
      }
    } catch (e) {
      logger.warn(`[script] memory save failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    try {
      if (process.env.VISOR_DEBUG === 'true') {
        const name = String((config as any).checkName || '');
        const t = typeof result;
        // Generic, step-agnostic debug
        console.error(
          `[script-return] ${name} outputType=${t} hasArray=${Array.isArray(result)} hasObj=${
            result && typeof result === 'object'
          }`
        );
      }
    } catch {}
    const out: any = { issues: [], output: result } as ReviewSummary & { output: unknown };
    try {
      (out as any).__histTracked = true;
    } catch {}
    return out;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'content',
      'depends_on',
      'group',
      'on',
      'if',
      'fail_if',
      'on_fail',
      'on_success',
    ];
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getRequirements(): string[] {
    return ['No external dependencies required'];
  }

  // No local buildTemplateContext; uses shared builder above
}
