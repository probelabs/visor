import { logger } from '../logger';

export interface WaitingPromptInfo {
  checkName: string;
  prompt: string;
  timestamp: number;
  channel: string;
  threadTs: string;
  promptMessageTs?: string;
  snapshotPath?: string;
  promptsPosted?: number; // how many prompts we posted into this thread
  context?: Record<string, unknown>;
}

export class PromptStateManager {
  private waiting = new Map<string, WaitingPromptInfo>(); // key: `${channel}:${threadTs}`
  private ttlMs: number;
  private timer?: NodeJS.Timeout;
  private firstMessage = new Map<string, { text: string; consumed: boolean }>();
  private summaryTs = new Map<string, Map<string, string>>(); // key: threadKey -> group -> ts

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.startCleanup();
  }

  private key(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  setWaiting(
    channel: string,
    threadTs: string,
    info: Omit<WaitingPromptInfo, 'timestamp' | 'channel' | 'threadTs'>
  ) {
    const key = this.key(channel, threadTs);
    const value: WaitingPromptInfo = { ...info, timestamp: Date.now(), channel, threadTs };
    this.waiting.set(key, value);
    try {
      logger.info(
        `[prompt-state] waiting set for ${key} (check=${info.checkName}, prompt="${info.prompt.substring(
          0,
          60
        )}…")`
      );
    } catch {}
  }

  getWaiting(channel: string, threadTs: string): WaitingPromptInfo | undefined {
    const key = this.key(channel, threadTs);
    const info = this.waiting.get(key);
    if (!info) return undefined;
    const age = Date.now() - info.timestamp;
    if (age > this.ttlMs) {
      this.waiting.delete(key);
      try {
        logger.warn(`[prompt-state] expired ${key} (age=${Math.round(age / 1000)}s)`);
      } catch {}
      return undefined;
    }
    return info;
  }

  clear(channel: string, threadTs: string): boolean {
    const key = this.key(channel, threadTs);
    const had = this.waiting.delete(key);
    if (had) {
      try {
        logger.info(`[prompt-state] cleared ${key}`);
      } catch {}
    }
    return had;
  }

  /** Merge updates into an existing waiting entry */
  update(
    channel: string,
    threadTs: string,
    patch: Partial<WaitingPromptInfo>
  ): WaitingPromptInfo | undefined {
    const key = this.key(channel, threadTs);
    const prev = this.waiting.get(key);
    if (!prev) return undefined;
    const next = { ...prev, ...patch } as WaitingPromptInfo;
    this.waiting.set(key, next);
    try {
      if (patch.snapshotPath) {
        logger.info(`[prompt-state] snapshotPath set for ${key}`);
      }
    } catch {}
    return next;
  }

  // First message capture helpers
  setFirstMessage(channel: string, threadTs: string, text: string): void {
    const key = this.key(channel, threadTs);
    if (!text || !text.trim()) return;
    const existing = this.firstMessage.get(key);
    // Only set if: no entry exists OR the existing entry was already consumed
    // This allows new messages to be captured after a resume cycle
    if (!existing || existing.consumed) {
      this.firstMessage.set(key, { text, consumed: false });
    }
  }
  consumeFirstMessage(channel: string, threadTs: string): string | undefined {
    const key = this.key(channel, threadTs);
    const entry = this.firstMessage.get(key);
    if (entry && !entry.consumed) {
      entry.consumed = true;
      this.firstMessage.set(key, entry);
      return entry.text;
    }
    return undefined;
  }
  hasUnconsumedFirstMessage(channel: string, threadTs: string): boolean {
    const key = this.key(channel, threadTs);
    const e = this.firstMessage.get(key);
    return !!(e && !e.consumed && e.text && e.text.trim());
  }

  private startCleanup(intervalMs: number = 5 * 60 * 1000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.cleanup(), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  private cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, info] of this.waiting.entries()) {
      if (now - info.timestamp > this.ttlMs) {
        this.waiting.delete(key);
        removed++;
      }
    }
    // Also clean up stale firstMessage entries (consumed entries older than TTL)
    // Keep unconsumed entries to avoid losing user messages
    for (const [key] of this.firstMessage.entries()) {
      const waitingInfo = this.waiting.get(key);
      // If no corresponding waiting entry exists and the firstMessage was consumed,
      // the conversation is likely complete - safe to remove
      if (!waitingInfo) {
        const entry = this.firstMessage.get(key);
        if (entry?.consumed) {
          this.firstMessage.delete(key);
          removed++;
        }
      }
    }
    if (removed) {
      try {
        logger.info(`[prompt-state] cleanup removed ${removed} entries`);
      } catch {}
    }
    return removed;
  }
}

let __promptState: PromptStateManager | undefined;
export function getPromptStateManager(ttlMs?: number): PromptStateManager {
  if (!__promptState) __promptState = new PromptStateManager(ttlMs);
  return __promptState;
}

export function resetPromptStateManager(): void {
  __promptState = undefined;
}
