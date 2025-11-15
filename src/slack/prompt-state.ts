import { logger } from '../logger';

/**
 * Information about a prompt waiting for user response
 */
export interface WaitingPromptInfo {
  /** Name of the check waiting for input */
  checkName: string;
  /** The prompt text shown to user */
  prompt: string;
  /** Timestamp when the prompt was created */
  timestamp: number;
  /** Workflow ID or execution context identifier */
  workflowId?: string;
  /** Channel where the prompt was posted */
  channel: string;
  /** Thread timestamp */
  threadTs: string;
  /** Message timestamp of the prompt */
  promptMessageTs?: string;
  /** Any additional context data */
  context?: Record<string, unknown>;
}

/**
 * Manages state of prompts waiting for user responses in Slack threads
 * Uses in-memory storage with TTL-based cleanup
 */
export class PromptStateManager {
  private waitingPrompts: Map<string, WaitingPromptInfo> = new Map();
  private readonly defaultTTL: number = 60 * 60 * 1000; // 1 hour in milliseconds
  private cleanupInterval?: NodeJS.Timeout;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.defaultTTL = ttlMs;
    this.startCleanupInterval();
  }

  /**
   * Mark a thread as waiting for user input
   * @param threadId Unique thread identifier (e.g., "C123:1700.55")
   * @param info Prompt information
   */
  setWaiting(threadId: string, info: WaitingPromptInfo): void {
    this.waitingPrompts.set(threadId, {
      ...info,
      timestamp: Date.now(),
    });

    logger.info(
      `Thread ${threadId} is now waiting for input (check: ${info.checkName}, prompt: "${info.prompt.substring(0, 50)}...")`
    );
  }

  /**
   * Get waiting prompt information for a thread
   * @param threadId Thread identifier
   * @returns Prompt info if waiting, undefined otherwise
   */
  getWaiting(threadId: string): WaitingPromptInfo | undefined {
    const info = this.waitingPrompts.get(threadId);

    if (!info) {
      return undefined;
    }

    // Check if prompt has expired
    const age = Date.now() - info.timestamp;
    if (age > this.defaultTTL) {
      logger.warn(
        `Prompt in thread ${threadId} has expired (age: ${Math.round(age / 1000)}s, TTL: ${Math.round(this.defaultTTL / 1000)}s)`
      );
      this.waitingPrompts.delete(threadId);
      return undefined;
    }

    return info;
  }

  /**
   * Check if a thread is waiting for input
   * @param threadId Thread identifier
   * @returns true if waiting and not expired
   */
  isWaiting(threadId: string): boolean {
    return this.getWaiting(threadId) !== undefined;
  }

  /**
   * Clear waiting state for a thread
   * @param threadId Thread identifier
   * @returns true if a waiting prompt was cleared
   */
  clearWaiting(threadId: string): boolean {
    const had = this.waitingPrompts.has(threadId);
    if (had) {
      this.waitingPrompts.delete(threadId);
      logger.info(`Cleared waiting state for thread ${threadId}`);
    }
    return had;
  }

  /**
   * Get all waiting threads
   * @returns Array of thread IDs currently waiting for input
   */
  getWaitingThreads(): string[] {
    return Array.from(this.waitingPrompts.keys());
  }

  /**
   * Get count of waiting prompts
   * @returns Number of threads waiting for input
   */
  getWaitingCount(): number {
    return this.waitingPrompts.size;
  }

  /**
   * Clean up expired prompts
   * @returns Number of expired prompts removed
   */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;

    for (const [threadId, info] of this.waitingPrompts.entries()) {
      const age = now - info.timestamp;
      if (age > this.defaultTTL) {
        this.waitingPrompts.delete(threadId);
        removed++;
        logger.debug(
          `Removed expired prompt for thread ${threadId} (age: ${Math.round(age / 1000)}s)`
        );
      }
    }

    if (removed > 0) {
      logger.info(`Cleaned up ${removed} expired prompt(s)`);
    }

    return removed;
  }

  /**
   * Start periodic cleanup of expired prompts
   * Runs every 5 minutes by default
   */
  private startCleanupInterval(intervalMs: number = 5 * 60 * 1000): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, intervalMs);

    // Don't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug(`Started prompt cleanup interval (every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop cleanup interval (for testing/shutdown)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
      logger.debug('Stopped prompt cleanup interval');
    }
  }

  /**
   * Clear all waiting prompts (for testing/reset)
   */
  clear(): void {
    const count = this.waitingPrompts.size;
    this.waitingPrompts.clear();
    logger.info(`Cleared all ${count} waiting prompt(s)`);
  }

  /**
   * Get statistics about prompt state
   */
  getStats(): {
    total: number;
    expired: number;
    active: number;
  } {
    const now = Date.now();
    let expired = 0;
    let active = 0;

    for (const info of this.waitingPrompts.values()) {
      const age = now - info.timestamp;
      if (age > this.defaultTTL) {
        expired++;
      } else {
        active++;
      }
    }

    return {
      total: this.waitingPrompts.size,
      expired,
      active,
    };
  }
}

// Global singleton instance
let globalPromptState: PromptStateManager | undefined;

/**
 * Get the global prompt state manager instance
 * Creates one if it doesn't exist
 */
export function getPromptStateManager(ttlMs?: number): PromptStateManager {
  if (!globalPromptState) {
    globalPromptState = new PromptStateManager(ttlMs);
  }
  return globalPromptState;
}

/**
 * Reset the global prompt state manager (for testing)
 */
export function resetPromptStateManager(): void {
  if (globalPromptState) {
    globalPromptState.stopCleanup();
    globalPromptState.clear();
    globalPromptState = undefined;
  }
}
