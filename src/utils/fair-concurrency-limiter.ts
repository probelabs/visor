/**
 * Fair round-robin concurrency limiter.
 *
 * Single global limiter for all AI/delegation calls in the process.
 * Instead of FIFO (which lets one session hog all slots), this grants
 * slots in round-robin order across sessions so every user gets fair access.
 *
 * Usage:
 *   const limiter = FairConcurrencyLimiter.getInstance(maxConcurrent);
 *   await limiter.acquire(sessionId);  // blocks until slot available
 *   try { ... } finally { limiter.release(sessionId); }
 */

import { logger } from '../logger';

interface WaitEntry {
  resolve: (value: boolean) => void;
  reject: (error: Error) => void;
  queuedAt: number;
  reminder?: ReturnType<typeof setInterval>;
}

export class FairConcurrencyLimiter {
  private maxConcurrent: number;
  private globalActive = 0;

  // Per-session FIFO queues
  private sessionQueues = new Map<string, WaitEntry[]>();
  // Round-robin order of sessions with waiting entries
  private roundRobinSessions: string[] = [];
  private roundRobinIndex = 0;

  // Per-session active count (for stats)
  private sessionActive = new Map<string, number>();

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  static getInstance(maxConcurrent: number): FairConcurrencyLimiter {
    const key = Symbol.for('visor.fairConcurrencyLimiter');
    let instance = (globalThis as any)[key] as FairConcurrencyLimiter | undefined;
    if (!instance) {
      instance = new FairConcurrencyLimiter(maxConcurrent);
      (globalThis as any)[key] = instance;
      logger.info(`[FairLimiter] Created global fair concurrency limiter (max: ${maxConcurrent})`);
    } else if (instance.maxConcurrent !== maxConcurrent) {
      // Config changed — update max (live resize)
      const old = instance.maxConcurrent;
      instance.maxConcurrent = maxConcurrent;
      logger.info(`[FairLimiter] Updated max concurrency: ${old} -> ${maxConcurrent}`);
      // Process queue in case new slots opened up
      instance._processQueue();
    }
    return instance;
  }

  /**
   * Try to acquire a slot immediately (non-blocking).
   */
  tryAcquire(sessionId?: string | null): boolean {
    if (this.globalActive >= this.maxConcurrent) {
      return false;
    }
    this.globalActive++;
    const sid = sessionId || '__anonymous__';
    this.sessionActive.set(sid, (this.sessionActive.get(sid) || 0) + 1);
    return true;
  }

  /**
   * Acquire a slot, waiting in a fair queue if necessary.
   * Sessions are served round-robin so no single session can starve others.
   */
  async acquire(
    sessionId?: string | null,
    _debug?: boolean,
    queueTimeout?: number | null
  ): Promise<boolean> {
    const sid = sessionId || '__anonymous__';

    // Fast path — slot available
    if (this.tryAcquire(sid)) {
      return true;
    }

    // Compute queue stats for logging
    const totalQueued = this._totalQueued();
    const sessionsWaiting = this.sessionQueues.size;
    const sessionQueueLen = this.sessionQueues.get(sid)?.length || 0;
    logger.info(
      `[FairLimiter] Slot unavailable (${this.globalActive}/${this.maxConcurrent} active). ` +
        `Session "${sid}" queued (${sessionQueueLen} own + ${totalQueued} total across ${sessionsWaiting} sessions). Waiting...`
    );

    const queuedAt = Date.now();
    const effectiveTimeout = queueTimeout ?? 120000; // default 2 min

    return new Promise<boolean>((resolve, reject) => {
      const entry: WaitEntry = { resolve, reject, queuedAt };

      // Periodic reminder every 15s
      entry.reminder = setInterval(() => {
        const waited = Math.round((Date.now() - queuedAt) / 1000);
        const curQueued = this._totalQueued();
        const curSessions = this._waitingSessions();
        logger.info(
          `[FairLimiter] Session "${sid}" still waiting (${waited}s). ` +
            `${this.globalActive}/${this.maxConcurrent} active, ` +
            `${curQueued} queued across ${curSessions} sessions.`
        );
      }, 15000);

      // Add to this session's queue
      let queue = this.sessionQueues.get(sid);
      if (!queue) {
        queue = [];
        this.sessionQueues.set(sid, queue);
        // Add to round-robin rotation
        this.roundRobinSessions.push(sid);
      }
      queue.push(entry);

      // Timeout
      if (effectiveTimeout > 0) {
        setTimeout(() => {
          // Remove from queue if still there
          const q = this.sessionQueues.get(sid);
          if (q) {
            const idx = q.indexOf(entry);
            if (idx !== -1) {
              q.splice(idx, 1);
              if (q.length === 0) {
                this.sessionQueues.delete(sid);
                this._removeFromRoundRobin(sid);
              }
              this._clearReminder(entry);
              reject(
                new Error(
                  `[FairLimiter] Queue timeout: session "${sid}" waited ${effectiveTimeout}ms for a slot`
                )
              );
            }
          }
        }, effectiveTimeout);
      }
    });
  }

  /**
   * Release a slot and grant the next one fairly (round-robin across sessions).
   */
  release(sessionId?: string | null, _debug?: boolean): void {
    const sid = sessionId || '__anonymous__';
    this.globalActive = Math.max(0, this.globalActive - 1);

    const active = this.sessionActive.get(sid);
    if (active !== undefined) {
      if (active <= 1) {
        this.sessionActive.delete(sid);
      } else {
        this.sessionActive.set(sid, active - 1);
      }
    }

    this._processQueue();
  }

  /**
   * Round-robin queue processing: cycle through sessions and grant one slot per session per round.
   */
  private _processQueue(): void {
    const toGrant: Array<{ entry: WaitEntry; sid: string }> = [];

    while (this.globalActive < this.maxConcurrent && this.roundRobinSessions.length > 0) {
      // Wrap index
      if (this.roundRobinIndex >= this.roundRobinSessions.length) {
        this.roundRobinIndex = 0;
      }

      const sid = this.roundRobinSessions[this.roundRobinIndex];
      const queue = this.sessionQueues.get(sid);

      if (!queue || queue.length === 0) {
        // Session has no more waiters — remove from rotation
        this.sessionQueues.delete(sid);
        this.roundRobinSessions.splice(this.roundRobinIndex, 1);
        // Don't increment index — next session slides into this position
        continue;
      }

      // Grant the oldest entry from this session
      const entry = queue.shift()!;
      if (queue.length === 0) {
        this.sessionQueues.delete(sid);
        this.roundRobinSessions.splice(this.roundRobinIndex, 1);
        // Don't increment — next session slides in
      } else {
        this.roundRobinIndex++;
      }

      this.globalActive++;
      this.sessionActive.set(sid, (this.sessionActive.get(sid) || 0) + 1);
      toGrant.push({ entry, sid });
    }

    // Resolve outside the loop to avoid reentrancy issues
    for (const { entry, sid } of toGrant) {
      this._clearReminder(entry);
      const waitedMs = Date.now() - entry.queuedAt;
      if (waitedMs > 100) {
        logger.info(
          `[FairLimiter] Session "${sid}" acquired slot after ${Math.round(waitedMs / 1000)}s wait.`
        );
      }
      // Defer to next tick to avoid blocking event loop
      setImmediate(() => entry.resolve(true));
    }
  }

  getStats(): {
    globalActive: number;
    maxConcurrent: number;
    queueSize: number;
    waitingSessions: number;
    perSession: Record<string, { active: number; queued: number }>;
  } {
    const perSession: Record<string, { active: number; queued: number }> = {};
    const allSessions = new Set([...this.sessionActive.keys(), ...this.sessionQueues.keys()]);
    for (const sid of allSessions) {
      perSession[sid] = {
        active: this.sessionActive.get(sid) || 0,
        queued: this.sessionQueues.get(sid)?.length || 0,
      };
    }
    return {
      globalActive: this.globalActive,
      maxConcurrent: this.maxConcurrent,
      queueSize: this._totalQueued(),
      waitingSessions: this._waitingSessions(),
      perSession,
    };
  }

  cleanup(): void {
    // Clear all reminders
    for (const queue of this.sessionQueues.values()) {
      for (const entry of queue) {
        this._clearReminder(entry);
      }
    }
    this.sessionQueues.clear();
    this.roundRobinSessions = [];
    this.roundRobinIndex = 0;
    // Remove singleton
    const key = Symbol.for('visor.fairConcurrencyLimiter');
    delete (globalThis as any)[key];
  }

  shutdown(): void {
    this.cleanup();
  }

  // -- helpers --

  private _totalQueued(): number {
    let n = 0;
    for (const q of this.sessionQueues.values()) n += q.length;
    return n;
  }

  private _waitingSessions(): number {
    return this.roundRobinSessions.length;
  }

  private _removeFromRoundRobin(sid: string): void {
    const idx = this.roundRobinSessions.indexOf(sid);
    if (idx !== -1) {
      this.roundRobinSessions.splice(idx, 1);
      if (this.roundRobinIndex > idx) {
        this.roundRobinIndex--;
      }
    }
  }

  private _clearReminder(entry: WaitEntry): void {
    if (entry.reminder) {
      clearInterval(entry.reminder);
      entry.reminder = undefined;
    }
  }
}
