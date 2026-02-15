// Mock for @probelabs/probe
export class ProbeAgent {
  constructor(options?: any) {
    // Mock constructor
  }

  async initialize(): Promise<void> {
    // Mock initialize hook (no-op)
  }

  async answer(message: string, images?: any[], options?: any): Promise<string> {
    // Mock implementation that will be overridden in tests
    return JSON.stringify({
      issues: [],
    });
  }

  getTokenUsage(): any {
    return {
      total: 100,
      request: 50,
      response: 50,
    };
  }
}

/**
 * Mock DelegationManager for testing concurrency limiter features.
 * Mirrors the real DelegationManager API from @probelabs/probe.
 */
export class DelegationManager {
  private maxConcurrent: number;
  private maxPerSession: number;
  private defaultQueueTimeout: number;
  private globalActive: number;
  private waitQueue: any[];
  private sessionDelegations: Map<string, any>;
  private cleanupInterval: any;

  constructor(options: any = {}) {
    this.maxConcurrent = options.maxConcurrent
      ?? parseInt(process.env.MAX_CONCURRENT_DELEGATIONS || '3', 10);
    this.maxPerSession = options.maxPerSession
      ?? parseInt(process.env.MAX_DELEGATIONS_PER_SESSION || '10', 10);
    this.defaultQueueTimeout = options.queueTimeout
      ?? parseInt(process.env.DELEGATION_QUEUE_TIMEOUT || '60000', 10);
    this.globalActive = 0;
    this.waitQueue = [];
    this.sessionDelegations = new Map();
    this.cleanupInterval = null;
  }

  async acquire(parentSessionId?: string | null): Promise<boolean> {
    if (this.globalActive >= this.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.waitQueue.push({ resolve, reject, parentSessionId });
      });
    }
    this.globalActive++;
    return true;
  }

  release(parentSessionId?: string | null): void {
    this.globalActive = Math.max(0, this.globalActive - 1);
    if (this.waitQueue.length > 0 && this.globalActive < this.maxConcurrent) {
      const next = this.waitQueue.shift();
      this.globalActive++;
      next.resolve(true);
    }
  }

  getStats(): any {
    return {
      globalActive: this.globalActive,
      maxConcurrent: this.maxConcurrent,
      maxPerSession: this.maxPerSession,
      defaultQueueTimeout: this.defaultQueueTimeout,
      sessionCount: this.sessionDelegations.size,
      queueSize: this.waitQueue.length,
    };
  }

  cleanup(): void {
    for (const entry of this.waitQueue) {
      entry.reject(new Error('DelegationManager was cleaned up'));
    }
    this.waitQueue = [];
    this.sessionDelegations.clear();
    this.globalActive = 0;
  }
}

// Re-export types from the actual module (they'll be available from the real package)
export type { ProbeAgentOptions } from '@probelabs/probe';
