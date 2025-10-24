import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { MemoryStore } from '../memory-store';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';

/**
 * Memory operation types
 */
export type MemoryOperation =
  | 'get'
  | 'set'
  | 'append'
  | 'increment'
  | 'delete'
  | 'clear'
  | 'list'
  | 'exec_js';

/**
 * Check provider for memory/state management
 * Supports in-memory and persistent storage with namespace isolation
 */
export class MemoryCheckProvider extends CheckProvider {
  private liquid: Liquid;
  private sandbox?: Sandbox;

  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false,
    });
  }

  /**
   * Create a secure sandbox for JavaScript execution
   */
  private createSecureSandbox(): Sandbox {
    return createSecureSandbox();
  }

  getName(): string {
    return 'memory';
  }

  getDescription(): string {
    return 'Memory/state management provider for persistent key-value storage across checks';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    if (!config || typeof config !== 'object') {
      return false;
    }

    const cfg = config as CheckProviderConfig;

    // Type must be 'memory'
    if (cfg.type !== 'memory') {
      return false;
    }

    // Operation is required
    if (!cfg.operation || typeof cfg.operation !== 'string') {
      return false;
    }

    const operation = cfg.operation as string;
    const validOps = ['get', 'set', 'append', 'increment', 'delete', 'clear', 'list', 'exec_js'];
    if (!validOps.includes(operation)) {
      return false;
    }

    // Key is required for get, set, append, increment, delete
    if (['get', 'set', 'append', 'increment', 'delete'].includes(operation)) {
      if (!cfg.key || typeof cfg.key !== 'string') {
        return false;
      }
    }

    // Value or value_js is required for set and append
    if (['set', 'append'].includes(operation)) {
      if (cfg.value === undefined && !cfg.value_js) {
        return false;
      }
    }

    // exec_js requires memory_js
    if (operation === 'exec_js') {
      if (!cfg.memory_js || typeof cfg.memory_js !== 'string') {
        return false;
      }
    }

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: { parentSessionId?: string; reuseSession?: boolean }
  ): Promise<ReviewSummary> {
    const operation = config.operation as MemoryOperation;
    const key = config.key as string | undefined;
    const namespace = config.namespace as string | undefined;

    // Get memory store instance
    const memoryStore = MemoryStore.getInstance();

    // Build template context for value computation
    const templateContext = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      config.__outputHistory as Map<string, unknown[]> | undefined
    );

    let result: unknown;

    try {
      switch (operation) {
        case 'get':
          result = await this.handleGet(memoryStore, key!, namespace);
          break;
        case 'set':
          result = await this.handleSet(memoryStore, key!, config, namespace, templateContext);
          break;
        case 'append':
          result = await this.handleAppend(memoryStore, key!, config, namespace, templateContext);
          break;
        case 'increment':
          result = await this.handleIncrement(
            memoryStore,
            key!,
            config,
            namespace,
            templateContext
          );
          break;
        case 'delete':
          result = await this.handleDelete(memoryStore, key!, namespace);
          break;
        case 'clear':
          result = await this.handleClear(memoryStore, namespace);
          break;
        case 'list':
          result = await this.handleList(memoryStore, namespace);
          break;
        case 'exec_js':
          result = await this.handleExecJs(memoryStore, config, templateContext);
          break;
        default:
          throw new Error(`Unknown memory operation: ${operation}`);
      }

      // Return result as output
      return {
        issues: [],
        output: result,
      } as ReviewSummary & { output: unknown };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error in memory operation';
      logger.error(`Memory operation failed: ${errorMsg}`);

      return {
        issues: [],
        output: null,
        error: errorMsg,
      } as ReviewSummary & { output: null; error: string };
    }
  }

  private async handleGet(store: MemoryStore, key: string, namespace?: string): Promise<unknown> {
    const value = store.get(key, namespace);
    logger.debug(
      `Memory GET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
    );
    return value;
  }

  private async handleSet(
    store: MemoryStore,
    key: string,
    config: CheckProviderConfig,
    namespace: string | undefined,
    context: Record<string, unknown>
  ): Promise<unknown> {
    const value = await this.computeValue(config, context);
    await store.set(key, value, namespace);
    logger.debug(
      `Memory SET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
    );
    return value;
  }

  private async handleAppend(
    store: MemoryStore,
    key: string,
    config: CheckProviderConfig,
    namespace: string | undefined,
    context: Record<string, unknown>
  ): Promise<unknown> {
    const value = await this.computeValue(config, context);
    await store.append(key, value, namespace);
    const result = store.get(key, namespace);
    logger.debug(
      `Memory APPEND: ${namespace || store.getDefaultNamespace()}.${key} += ${JSON.stringify(value)} (now: ${JSON.stringify(result)})`
    );
    return result;
  }

  private async handleIncrement(
    store: MemoryStore,
    key: string,
    config: CheckProviderConfig,
    namespace: string | undefined,
    context: Record<string, unknown>
  ): Promise<number> {
    // Compute amount - default to 1 if not specified
    let amount = 1;
    if (config.value !== undefined || config.value_js) {
      const computedValue = await this.computeValue(config, context);
      if (typeof computedValue === 'number') {
        amount = computedValue;
      } else {
        throw new Error(`Increment amount must be a number, got ${typeof computedValue}`);
      }
    }

    const result = await store.increment(key, amount, namespace);
    logger.debug(
      `Memory INCREMENT: ${namespace || store.getDefaultNamespace()}.${key} += ${amount} (now: ${result})`
    );
    return result;
  }

  private async handleDelete(
    store: MemoryStore,
    key: string,
    namespace?: string
  ): Promise<boolean> {
    const deleted = await store.delete(key, namespace);
    logger.debug(
      `Memory DELETE: ${namespace || store.getDefaultNamespace()}.${key} (deleted: ${deleted})`
    );
    return deleted;
  }

  private async handleClear(store: MemoryStore, namespace?: string): Promise<void> {
    await store.clear(namespace);
    logger.debug(`Memory CLEAR: ${namespace ? `namespace ${namespace}` : 'all namespaces'}`);
  }

  private async handleList(store: MemoryStore, namespace?: string): Promise<string[]> {
    const keys = store.list(namespace);
    logger.debug(`Memory LIST: ${namespace || store.getDefaultNamespace()} (${keys.length} keys)`);
    return keys;
  }

  private async handleExecJs(
    store: MemoryStore,
    config: CheckProviderConfig,
    context: Record<string, unknown>
  ): Promise<unknown> {
    const script = config.memory_js as string;

    // Track operations that need to be saved
    const pendingOps: Array<() => Promise<void>> = [];

    // Create enhanced context with memory operations
    // Note: These operations are synchronous for simplicity in scripts
    // The actual async save happens after script execution
    const enhancedContext = {
      ...context,
      memory: {
        get: (key: string, ns?: string) => store.get(key, ns),
        set: (key: string, value: unknown, ns?: string) => {
          // Store operation synchronously in memory
          const nsName = ns || store.getDefaultNamespace();
          if (!store['data'].has(nsName)) {
            store['data'].set(nsName, new Map());
          }
          store['data'].get(nsName)!.set(key, value);
          // Queue async save for later
          pendingOps.push(async () => {
            if (store.getConfig().storage === 'file' && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return value;
        },
        append: (key: string, value: unknown, ns?: string) => {
          const existing = store.get(key, ns);
          let newValue: unknown[];
          if (existing === undefined) {
            newValue = [value];
          } else if (Array.isArray(existing)) {
            newValue = [...existing, value];
          } else {
            newValue = [existing, value];
          }
          // Use sync set
          const nsName = ns || store.getDefaultNamespace();
          if (!store['data'].has(nsName)) {
            store['data'].set(nsName, new Map());
          }
          store['data'].get(nsName)!.set(key, newValue);
          // Queue async save
          pendingOps.push(async () => {
            if (store.getConfig().storage === 'file' && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return newValue;
        },
        increment: (key: string, amount = 1, ns?: string) => {
          const existing = store.get(key, ns);
          let newValue: number;
          if (existing === undefined || existing === null) {
            newValue = amount;
          } else if (typeof existing === 'number') {
            newValue = existing + amount;
          } else {
            throw new Error(
              `Cannot increment non-numeric value at key '${key}' (type: ${typeof existing})`
            );
          }
          // Use sync set
          const nsName = ns || store.getDefaultNamespace();
          if (!store['data'].has(nsName)) {
            store['data'].set(nsName, new Map());
          }
          store['data'].get(nsName)!.set(key, newValue);
          // Queue async save
          pendingOps.push(async () => {
            if (store.getConfig().storage === 'file' && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return newValue;
        },
        delete: (key: string, ns?: string) => {
          const nsName = ns || store.getDefaultNamespace();
          const nsData = store['data'].get(nsName);
          const deleted = nsData?.delete(key) || false;
          // Queue async save
          if (deleted) {
            pendingOps.push(async () => {
              if (store.getConfig().storage === 'file' && store.getConfig().auto_save) {
                await store.save();
              }
            });
          }
          return deleted;
        },
        clear: (ns?: string) => {
          if (ns) {
            store['data'].delete(ns);
          } else {
            store['data'].clear();
          }
          // Queue async save
          pendingOps.push(async () => {
            if (store.getConfig().storage === 'file' && store.getConfig().auto_save) {
              await store.save();
            }
          });
        },
        list: (ns?: string) => store.list(ns),
        has: (key: string, ns?: string) => store.has(key, ns),
        getAll: (ns?: string) => store.getAll(ns),
        listNamespaces: () => store.listNamespaces(),
      },
    };

    try {
      if (
        (config as any).checkName === 'aggregate-validations' ||
        (config as any).checkName === 'aggregate' ||
        (config as any).checkName === 'aggregate'
      ) {
        const hist = (enhancedContext as any)?.outputs?.history || {};
        const keys = Object.keys(hist);
        console.log('[MemoryProvider]', (config as any).checkName, ': history keys =', keys);
        const vf = (hist as any)['validate-fact'];
        console.log(
          '[MemoryProvider]',
          (config as any).checkName,
          ': validate-fact history length =',
          Array.isArray(vf) ? vf.length : 'n/a'
        );
      }
    } catch {}

    const result = this.evaluateJavaScriptBlock(script, enhancedContext);
    try {
      if ((config as any).checkName === 'aggregate-validations') {
        const tv = store.get('total_validations', 'fact-validation');
        const av = store.get('all_valid', 'fact-validation');
        console.error(
          '[MemoryProvider] post-exec',
          (config as any).checkName,
          'total_validations=',
          tv,
          'all_valid=',
          av
        );
      }
    } catch {}

    // Execute pending async operations
    if (
      pendingOps.length > 0 &&
      store.getConfig().storage === 'file' &&
      store.getConfig().auto_save
    ) {
      // Only save once after all operations
      await store.save();
    }

    logger.debug(`Memory EXEC_JS: Executed custom script with ${pendingOps.length} operations`);
    return result;
  }

  /**
   * Compute value from config using value, value_js, transform, or transform_js
   */
  private async computeValue(
    config: CheckProviderConfig,
    context: Record<string, unknown>
  ): Promise<unknown> {
    let value: unknown;

    // Start with direct value or value_js
    if (config.value_js && typeof config.value_js === 'string') {
      value = this.evaluateJavaScript(config.value_js, context);
    } else {
      value = config.value;
    }

    // Apply transform template if provided
    if (config.transform && typeof config.transform === 'string') {
      const rendered = await this.liquid.parseAndRender(config.transform, {
        ...context,
        value,
      });
      value = rendered;
    }

    // Apply transform_js if provided
    if (config.transform_js && typeof config.transform_js === 'string') {
      value = this.evaluateJavaScript(config.transform_js, { ...context, value });
    }

    return value;
  }

  /**
   * Evaluate JavaScript expression in context using SandboxJS for secure execution
   */
  private evaluateJavaScript(expression: string, context: Record<string, unknown>): unknown {
    if (!this.sandbox) {
      this.sandbox = this.createSecureSandbox();
    }

    try {
      const scope: Record<string, unknown> = { ...context };
      return compileAndRun<unknown>(this.sandbox, `return (${expression});`, scope, {
        injectLog: true,
        wrapFunction: false,
        logPrefix: '[memory:value_js]',
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to evaluate value_js: ${errorMsg}`);
    }
  }

  /**
   * Evaluate JavaScript block (multi-line script) using SandboxJS for secure execution
   * Unlike evaluateJavaScript, this supports full scripts with statements, not just expressions
   */
  private evaluateJavaScriptBlock(script: string, context: Record<string, unknown>): unknown {
    if (!this.sandbox) {
      this.sandbox = this.createSecureSandbox();
    }

    try {
      const scope: Record<string, unknown> = { ...context };
      return compileAndRun<unknown>(this.sandbox, script, scope, {
        injectLog: true,
        wrapFunction: false,
        logPrefix: '[memory:exec_js]',
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[memory-js] Script execution error: ${errorMsg}`);
      throw new Error(`Failed to execute memory_js: ${errorMsg}`);
    }
  }

  /**
   * Build template context for Liquid and JS evaluation
   */
  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    memoryStore?: MemoryStore,
    outputHistory?: Map<string, unknown[]>
  ): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    // Add PR context
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

    // Add dependency outputs - always create outputs object even if no dependencies
    const outputs: Record<string, unknown> = {};
    const outputsRaw: Record<string, unknown> = {};
    const history: Record<string, unknown[]> = {};

    if (dependencyResults) {
      for (const [checkName, result] of dependencyResults.entries()) {
        // Defensive: some callers may accidentally provide non-string keys
        if (typeof checkName !== 'string') continue;
        const summary = result as ReviewSummary & { output?: unknown };
        if (typeof checkName === 'string' && checkName.endsWith('-raw')) {
          const name = checkName.slice(0, -4);
          outputsRaw[name] = summary.output !== undefined ? summary.output : summary;
        } else {
          outputs[checkName] = summary.output !== undefined ? summary.output : summary;
        }
      }
    }

    // Add history for each check if available
    if (outputHistory) {
      for (const [checkName, historyArray] of outputHistory) {
        history[checkName] = historyArray;
      }
    }

    // Attach history to the outputs object
    (outputs as any).history = history;

    context.outputs = outputs;
    // Alias for consistency: outputs_history mirrors outputs.history
    (context as any).outputs_history = history;
    // New: outputs_raw exposes aggregate values for forEach parents
    (context as any).outputs_raw = outputsRaw;

    // Add memory accessor
    if (memoryStore) {
      context.memory = {
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
          return true;
        },
        increment: (key: string, amount: number = 1, ns?: string) => {
          const nsName = ns || memoryStore.getDefaultNamespace();
          const current = memoryStore.get(key, nsName);
          const numCurrent = typeof current === 'number' ? (current as number) : 0;
          const newValue = numCurrent + amount;
          if (!(memoryStore as any)['data'].has(nsName)) {
            (memoryStore as any)['data'].set(nsName, new Map());
          }
          (memoryStore as any)['data'].get(nsName)!.set(key, newValue);
          return newValue;
        },
      } as Record<string, unknown>;
    }

    // SECURITY: Do NOT expose process.env to user-controlled scripts
    // Removed: context.env = process.env;
    // Environment variables, especially secrets like GITHUB_TOKEN, must not be
    // accessible to scripts defined in .visor.yaml as this would allow credential theft

    return context;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'operation',
      'key',
      'value',
      'value_js',
      'memory_js',
      'transform',
      'transform_js',
      'namespace',
      'depends_on',
      'group',
      'command',
      'on',
      'if',
      'fail_if',
      'on_fail',
      'on_success',
    ];
  }

  async isAvailable(): Promise<boolean> {
    // Memory provider is always available
    return true;
  }

  getRequirements(): string[] {
    return [
      'No external dependencies required',
      'Used for state management and persistent storage across checks',
    ];
  }
}
