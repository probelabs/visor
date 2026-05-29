import { logger } from '../../logger';

/** Resolve effective debounce time, respecting VISOR_DEBOUNCE_OVERRIDE env var for testing */
function effectiveDebounceMs(requested: number): number {
  const override = process.env.VISOR_DEBOUNCE_OVERRIDE;
  if (override !== undefined) {
    const ms = parseInt(override, 10);
    if (!isNaN(ms) && ms >= 0) return ms;
  }
  return requested;
}

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  invocations: number;
  firstInvocationTime: number;
  resolve: (value: { outcome: 'executed'; result: unknown } | { outcome: 'debounced' }) => void;
  reject: (err: unknown) => void;
  fn: () => Promise<unknown>;
}

/**
 * Global debounce manager for step execution.
 *
 * When a step has `debounce: <ms>`, multiple invocations within the debounce
 * window are coalesced — only the LAST invocation actually executes, after
 * the window expires with no new invocations.
 *
 * Additionally, if the function is currently executing, new invocations are
 * skipped (resolved as 'debounced') to prevent parallel executions.
 *
 * Key: typically `workflow:stepId` — callers decide the grouping.
 *
 * Earlier invocations resolve with 'debounced' (skipped).
 * The final invocation resolves with 'executed' after the real execution.
 */
export class DebounceManager {
  private pending = new Map<string, PendingEntry>();
  /** Waiters that were superseded and should resolve as 'debounced' */
  private superseded = new Map<string, Array<(v: { outcome: 'debounced' }) => void>>();
  /** Keys currently executing — prevents parallel runs */
  private executing = new Set<string>();

  /**
   * Enqueue an execution. Returns 'executed' if this invocation won the
   * debounce race, or 'debounced' if it was superseded by a later one
   * or if the function is already executing for this key.
   */
  enqueue(
    key: string,
    debounceMs: number,
    fn: () => Promise<unknown>
  ): Promise<{ outcome: 'executed'; result: unknown } | { outcome: 'debounced' }> {
    // If already executing for this key, skip immediately
    if (this.executing.has(key)) {
      logger.info(`[DebounceManager] ${key}: already executing, skipping this invocation`);
      return Promise.resolve({ outcome: 'debounced' });
    }

    const actualMs = effectiveDebounceMs(debounceMs);
    return new Promise<{ outcome: 'executed'; result: unknown } | { outcome: 'debounced' }>(
      (resolve, reject) => {
        const existing = this.pending.get(key);

        if (existing) {
          // Supersede previous invocation — it resolves as 'debounced'
          clearTimeout(existing.timer);
          // Move the previous resolve to superseded list
          if (!this.superseded.has(key)) {
            this.superseded.set(key, []);
          }
          this.superseded.get(key)!.push(existing.resolve as (v: { outcome: 'debounced' }) => void);
          existing.invocations++;

          logger.info(
            `[DebounceManager] ${key}: invocation #${existing.invocations}, resetting ${actualMs}ms timer`
          );
        } else {
          logger.info(
            `[DebounceManager] ${key}: first invocation, starting ${actualMs}ms debounce`
          );
        }

        const invocations = existing ? existing.invocations : 1;
        const firstTime = existing ? existing.firstInvocationTime : Date.now();

        const timer = setTimeout(async () => {
          this.pending.delete(key);

          // Resolve all superseded waiters as 'debounced'
          const waiters = this.superseded.get(key) || [];
          this.superseded.delete(key);
          for (const w of waiters) {
            w({ outcome: 'debounced' });
          }

          const elapsed = Date.now() - firstTime;
          logger.info(
            `[DebounceManager] ${key}: executing after ${invocations} invocation(s) over ${elapsed}ms`
          );

          // Mark as executing so concurrent invocations are skipped
          this.executing.add(key);
          try {
            const result = await fn();
            resolve({ outcome: 'executed', result });
          } catch (err) {
            reject(err);
          } finally {
            this.executing.delete(key);
            logger.info(`[DebounceManager] ${key}: execution finished`);
          }
        }, actualMs);

        this.pending.set(key, {
          timer,
          invocations,
          firstInvocationTime: firstTime,
          resolve,
          reject,
          fn,
        });
      }
    );
  }

  /** Cancel a pending debounce. All waiters resolve as 'debounced'. */
  cancel(key: string): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    entry.resolve({ outcome: 'debounced' });
    const waiters = this.superseded.get(key) || [];
    this.superseded.delete(key);
    for (const w of waiters) {
      w({ outcome: 'debounced' });
    }
    return true;
  }

  /** Cancel all pending debounces. */
  clear(): void {
    for (const [key] of this.pending) {
      this.cancel(key);
    }
  }

  /** Number of pending debounce keys. */
  get size(): number {
    return this.pending.size;
  }

  /** Check if a key is currently executing. */
  isExecuting(key: string): boolean {
    return this.executing.has(key);
  }
}

let __instance: DebounceManager | undefined;

export function getDebounceManager(): DebounceManager {
  if (!__instance) __instance = new DebounceManager();
  return __instance;
}

export function resetDebounceManager(): void {
  if (__instance) {
    __instance.clear();
    __instance = undefined;
  }
}
