import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { Liquid } from 'liquidjs';
import Sandbox from '@nyariv/sandboxjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import { MemoryStore } from '../memory-store';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';

/**
 * Provider that executes JavaScript in a secure sandbox.
 * Intended to replace most uses of the memory provider's exec_js operation with a
 * first-class step: `type: 'script'` + `content: | ...`.
 */
export class ScriptCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox?: Sandbox;

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
    return typeof cfg.content === 'string' && cfg.content.length > 0;
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

    // Build execution context (aligns with memory exec_js and command provider)
    const ctx = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      (config as any).__outputHistory as Map<string, unknown[]> | undefined,
      (_sessionInfo as any)?.stageHistoryBase as Record<string, number> | undefined
    );

    // Synchronous memory ops (mirror memory exec_js semantics)
    const pendingSave = { needed: false };
    (ctx as any).memory = {
      get: (key: string, ns?: string) => memoryStore.get(key, ns),
      has: (key: string, ns?: string) => memoryStore.has(key, ns),
      list: (ns?: string) => memoryStore.list(ns),
      getAll: (ns?: string) => memoryStore.getAll(ns),
      set: (key: string, value: unknown, ns?: string) => {
        const nsName = ns || memoryStore.getDefaultNamespace();
        if (!(memoryStore as any)['data'].has(nsName)) {
          (memoryStore as any)['data'].set(nsName, new Map());
        }
        (memoryStore as any)['data'].get(nsName)!.set(key, value);
        pendingSave.needed = true;
        return true;
      },
      append: (key: string, value: unknown, ns?: string) => {
        const existing = memoryStore.get(key, ns);
        let newValue: unknown[];
        if (existing === undefined) newValue = [value];
        else if (Array.isArray(existing)) newValue = [...existing, value];
        else newValue = [existing, value];
        const nsName = ns || memoryStore.getDefaultNamespace();
        if (!(memoryStore as any)['data'].has(nsName)) {
          (memoryStore as any)['data'].set(nsName, new Map());
        }
        (memoryStore as any)['data'].get(nsName)!.set(key, newValue);
        pendingSave.needed = true;
        return newValue;
      },
      increment: (key: string, amount = 1, ns?: string) => {
        const nsName = ns || memoryStore.getDefaultNamespace();
        const current = memoryStore.get(key, nsName);
        const num = typeof current === 'number' ? (current as number) : 0;
        const next = num + amount;
        if (!(memoryStore as any)['data'].has(nsName)) {
          (memoryStore as any)['data'].set(nsName, new Map());
        }
        (memoryStore as any)['data'].get(nsName)!.set(key, next);
        pendingSave.needed = true;
        return next;
      },
      delete: (key: string, ns?: string) => {
        const nsName = ns || memoryStore.getDefaultNamespace();
        const nsData = (memoryStore as any)['data'].get(nsName);
        if (!nsData) return false;
        const ok = nsData.delete(key);
        pendingSave.needed = pendingSave.needed || ok;
        return ok;
      },
      clear: (ns?: string) => {
        if (ns) (memoryStore as any)['data'].delete(ns);
        else (memoryStore as any)['data'].clear();
        pendingSave.needed = true;
      },
    } as Record<string, unknown>;

    // Evaluate the script in a secure sandbox
    if (!this.sandbox) this.sandbox = this.createSecureSandbox();
    let result: unknown;
    try {
      result = compileAndRun<unknown>(
        this.sandbox,
        script,
        { ...ctx },
        {
          injectLog: true,
          wrapFunction: false,
          logPrefix: '[script]',
        }
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[script] execution error: ${msg}`);
      return { issues: [], output: null, error: msg } as ReviewSummary & {
        output: null;
        error: string;
      };
    }

    // Persist file-backed memory once if needed
    try {
      if (
        pendingSave.needed &&
        memoryStore.getConfig().storage === 'file' &&
        memoryStore.getConfig().auto_save
      ) {
        await memoryStore.save();
      }
    } catch (e) {
      logger.warn(`[script] memory save failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { issues: [], output: result } as ReviewSummary & { output: unknown };
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

  /**
   * Build script context similar to memory/command providers
   */
  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    memoryStore?: MemoryStore,
    outputHistory?: Map<string, unknown[]>,
    stageHistoryBase?: Record<string, number>
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    context.pr = {
      number: prInfo.number,
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
      files: prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    };

    const outputs: Record<string, unknown> = {};
    const outputsRaw: Record<string, unknown> = {};
    const history: Record<string, unknown[]> = {};

    if (dependencyResults) {
      for (const [checkName, result] of dependencyResults.entries()) {
        if (typeof checkName !== 'string') continue;
        const summary = result as ReviewSummary & { output?: unknown };
        if (checkName.endsWith('-raw')) {
          const name = checkName.slice(0, -4);
          outputsRaw[name] = summary.output !== undefined ? summary.output : summary;
        } else {
          outputs[checkName] = summary.output !== undefined ? summary.output : summary;
        }
      }
    }

    if (outputHistory) {
      for (const [checkName, historyArray] of outputHistory) {
        history[checkName] = historyArray;
      }
    }

    const historyStage: Record<string, unknown[]> = {};
    try {
      if (outputHistory && stageHistoryBase) {
        for (const [checkName, historyArray] of outputHistory) {
          const start = stageHistoryBase[checkName] || 0;
          const arr = Array.isArray(historyArray) ? (historyArray as unknown[]) : [];
          historyStage[checkName] = arr.slice(start);
        }
      }
    } catch {}

    (outputs as any).history = history;
    context.outputs = outputs;
    (context as any).outputs_history = history;
    (context as any).outputs_history_stage = historyStage;
    (context as any).outputs_raw = outputsRaw;

    if (memoryStore) {
      context.memory = {
        get: (key: string, ns?: string) => memoryStore.get(key, ns),
        has: (key: string, ns?: string) => memoryStore.has(key, ns),
        list: (ns?: string) => memoryStore.list(ns),
        getAll: (ns?: string) => memoryStore.getAll(ns),
      } as Record<string, unknown>;
    }

    return context;
  }
}
