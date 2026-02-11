import {
  init_logger,
  logger
} from "./chunk-SZXICFQ3.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/slack/prompt-state.ts
function getPromptStateManager(ttlMs) {
  if (!__promptState) __promptState = new PromptStateManager(ttlMs);
  return __promptState;
}
function resetPromptStateManager() {
  __promptState = void 0;
}
var PromptStateManager, __promptState;
var init_prompt_state = __esm({
  "src/slack/prompt-state.ts"() {
    init_logger();
    PromptStateManager = class {
      waiting = /* @__PURE__ */ new Map();
      // key: `${channel}:${threadTs}`
      ttlMs;
      timer;
      firstMessage = /* @__PURE__ */ new Map();
      summaryTs = /* @__PURE__ */ new Map();
      // key: threadKey -> group -> ts
      constructor(ttlMs = 60 * 60 * 1e3) {
        this.ttlMs = ttlMs;
        this.startCleanup();
      }
      key(channel, threadTs) {
        return `${channel}:${threadTs}`;
      }
      setWaiting(channel, threadTs, info) {
        const key = this.key(channel, threadTs);
        const value = { ...info, timestamp: Date.now(), channel, threadTs };
        this.waiting.set(key, value);
        try {
          logger.info(
            `[prompt-state] waiting set for ${key} (check=${info.checkName}, prompt="${info.prompt.substring(
              0,
              60
            )}\u2026")`
          );
        } catch {
        }
      }
      getWaiting(channel, threadTs) {
        const key = this.key(channel, threadTs);
        const info = this.waiting.get(key);
        if (!info) return void 0;
        const age = Date.now() - info.timestamp;
        if (age > this.ttlMs) {
          this.waiting.delete(key);
          try {
            logger.warn(`[prompt-state] expired ${key} (age=${Math.round(age / 1e3)}s)`);
          } catch {
          }
          return void 0;
        }
        return info;
      }
      clear(channel, threadTs) {
        const key = this.key(channel, threadTs);
        const had = this.waiting.delete(key);
        if (had) {
          try {
            logger.info(`[prompt-state] cleared ${key}`);
          } catch {
          }
        }
        return had;
      }
      /** Merge updates into an existing waiting entry */
      update(channel, threadTs, patch) {
        const key = this.key(channel, threadTs);
        const prev = this.waiting.get(key);
        if (!prev) return void 0;
        const next = { ...prev, ...patch };
        this.waiting.set(key, next);
        try {
          if (patch.snapshotPath) {
            logger.info(`[prompt-state] snapshotPath set for ${key}`);
          }
        } catch {
        }
        return next;
      }
      // First message capture helpers
      setFirstMessage(channel, threadTs, text) {
        const key = this.key(channel, threadTs);
        if (!text || !text.trim()) return;
        const existing = this.firstMessage.get(key);
        if (!existing || existing.consumed) {
          this.firstMessage.set(key, { text, consumed: false });
        }
      }
      consumeFirstMessage(channel, threadTs) {
        const key = this.key(channel, threadTs);
        const entry = this.firstMessage.get(key);
        if (entry && !entry.consumed) {
          entry.consumed = true;
          this.firstMessage.set(key, entry);
          return entry.text;
        }
        return void 0;
      }
      hasUnconsumedFirstMessage(channel, threadTs) {
        const key = this.key(channel, threadTs);
        const e = this.firstMessage.get(key);
        return !!(e && !e.consumed && e.text && e.text.trim());
      }
      startCleanup(intervalMs = 5 * 60 * 1e3) {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => this.cleanup(), intervalMs);
        if (this.timer.unref) this.timer.unref();
      }
      cleanup() {
        const now = Date.now();
        let removed = 0;
        for (const [key, info] of this.waiting.entries()) {
          if (now - info.timestamp > this.ttlMs) {
            this.waiting.delete(key);
            removed++;
          }
        }
        for (const [key] of this.firstMessage.entries()) {
          const waitingInfo = this.waiting.get(key);
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
          } catch {
          }
        }
        return removed;
      }
    };
  }
});

export {
  PromptStateManager,
  getPromptStateManager,
  resetPromptStateManager,
  init_prompt_state
};
//# sourceMappingURL=chunk-LG4AUKHB.mjs.map