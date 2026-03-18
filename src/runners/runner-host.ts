import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { TaskStore } from '../agent-protocol/task-store';
import { logger } from '../logger';

/**
 * Orchestrates the lifecycle of multiple Runner instances running in parallel.
 *
 * Handles start/stop ordering, config broadcast, and shared task-store propagation.
 */
export class RunnerHost {
  private runners: Runner[] = [];

  /** Register a runner to be managed by this host. */
  addRunner(runner: Runner): void {
    this.runners.push(runner);
  }

  /** Return the list of registered runners. */
  getRunners(): readonly Runner[] {
    return this.runners;
  }

  /**
   * Start all registered runners concurrently.
   * If any runner fails to start, previously-started runners are stopped.
   */
  async startAll(): Promise<void> {
    const started: Runner[] = [];
    const results = await Promise.allSettled(
      this.runners.map(async runner => {
        await runner.start();
        started.push(runner);
      })
    );

    const failures = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
    if (failures.length > 0) {
      // Rollback: stop successfully-started runners
      await Promise.allSettled(started.map(r => r.stop()));
      const msgs = failures.map(f => (f.reason as Error)?.message ?? String(f.reason));
      throw new Error(`Failed to start runner(s): ${msgs.join('; ')}`);
    }
  }

  /**
   * Stop all registered runners concurrently.
   * Tolerates individual stop failures (logs warnings).
   */
  async stopAll(): Promise<void> {
    const results = await Promise.allSettled(this.runners.map(r => r.stop()));
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.warn(`[RunnerHost] Failed to stop runner "${this.runners[i].name}": ${reason}`);
      }
    }
  }

  /** Broadcast a config update to all runners. */
  broadcastConfigUpdate(cfg: VisorConfig): void {
    for (const runner of this.runners) {
      runner.updateConfig(cfg);
    }
  }

  /** Propagate a shared task store to all runners that support it. */
  setTaskStore(store: TaskStore, configPath?: string): void {
    for (const runner of this.runners) {
      if (runner.setTaskStore) {
        runner.setTaskStore(store, configPath);
      }
    }
  }

  /**
   * Phase 1 of graceful restart: stop listening for new connections/messages.
   * Frees ports so a new process can bind immediately.
   * Does NOT wait for in-flight work — call drainAll() after for that.
   */
  async stopListeningAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.runners.map(async runner => {
        if (runner.stopListening) {
          await runner.stopListening();
        }
      })
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.warn(
          `[RunnerHost] Failed to stop listening on runner "${this.runners[i].name}": ${reason}`
        );
      }
    }
  }

  /**
   * Drain all runners: stop accepting new work, wait for in-flight work to complete.
   * Runners without drain() fall back to stop().
   * @param timeoutMs - Max wait time in ms. 0 means wait indefinitely (default).
   */
  async drainAll(timeoutMs = 0): Promise<void> {
    const drainPromise = Promise.allSettled(
      this.runners.map(async runner => {
        if (runner.drain) {
          await runner.drain(timeoutMs);
        } else {
          await runner.stop();
        }
      })
    );

    let results: PromiseSettledResult<void>[];
    if (timeoutMs > 0) {
      results = await Promise.race([
        drainPromise,
        new Promise<PromiseSettledResult<void>[]>(resolve =>
          setTimeout(() => {
            logger.warn(
              `[RunnerHost] Drain timeout (${timeoutMs}ms) exceeded, force-stopping remaining runners`
            );
            // Force-stop all runners that may still be draining
            Promise.allSettled(this.runners.map(r => r.stop())).then(() => resolve([]));
          }, timeoutMs)
        ),
      ]);
    } else {
      results = await drainPromise;
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i]?.status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason;
        logger.warn(`[RunnerHost] Failed to drain runner "${this.runners[i].name}": ${reason}`);
      }
    }
  }
}
