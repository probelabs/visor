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

// Re-export types from the actual module (they'll be available from the real package)
export type { ProbeAgentOptions } from '@probelabs/probe';
