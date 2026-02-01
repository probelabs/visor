import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { MemoryStore } from '../memory-store';
import { Liquid } from 'liquidjs';
import { createExtendedLiquid } from '../liquid-extensions';
import { logger } from '../logger';
import Sandbox from '@nyariv/sandboxjs';
import { createSecureSandbox, compileAndRun } from '../utils/sandbox';
import { buildProviderTemplateContext } from '../utils/template-context';
import { createSyncMemoryOps } from '../utils/script-memory-ops';

/**
 * Memory operation types
 */
export type MemoryOperation = 'get' | 'set' | 'append' | 'increment' | 'delete' | 'clear' | 'list';

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
    const validOps = ['get', 'set', 'append', 'increment', 'delete', 'clear', 'list'];
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

    // For custom scripting use the ScriptCheckProvider (type: 'script').

    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    _sessionInfo?: {
      parentSessionId?: string;
      reuseSession?: boolean;
    } & import('./check-provider.interface').ExecutionContext
  ): Promise<ReviewSummary> {
    const operation = config.operation as MemoryOperation | undefined;
    const key = config.key as string | undefined;
    const namespace = config.namespace as string | undefined;

    // Get memory store instance
    const memoryStore = MemoryStore.getInstance();

    // Build template context for value computation
    const templateContext = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      config.__outputHistory as Map<string, unknown[]> | undefined,
      (_sessionInfo as any)?.stageHistoryBase as Record<string, number> | undefined,
      _sessionInfo?.args
    );

    let result: unknown;

    // No implicit fallbacks; operation must be explicitly provided.

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

  // For custom JavaScript execution use ScriptCheckProvider.

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
    this.sandbox = this.createSecureSandbox();

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

  // No full-script execution in memory provider. Use ScriptCheckProvider.

  /**
   * Build template context for Liquid and JS evaluation
   */
  private buildTemplateContext(
    prInfo: PRInfo,
    dependencyResults?: Map<string, ReviewSummary>,
    memoryStore?: MemoryStore,
    outputHistory?: Map<string, unknown[]>,
    stageHistoryBase?: Record<string, number>,
    args?: Record<string, unknown>
  ): Record<string, unknown> {
    const base = buildProviderTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      outputHistory as Map<string, unknown[]> | undefined,
      stageHistoryBase,
      { attachMemoryReadHelpers: true, args }
    );
    if (memoryStore) {
      const { ops } = createSyncMemoryOps(memoryStore);
      (base as any).memory = ops;
    }
    return base;
  }

  getSupportedConfigKeys(): string[] {
    return [
      'type',
      'operation',
      'key',
      'value',
      'value_js',
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
