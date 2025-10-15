import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('Output History Integration Tests', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it('should track history across forEach iterations', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'list-items': {
          type: 'command',
          exec: "echo '[1, 2, 3, 4, 5]'",
          forEach: true,
        },
        'process-item': {
          type: 'memory',
          operation: 'exec_js',
          depends_on: ['list-items'],
          memory_js: `
            const item = outputs["list-items"];
            return { processedItem: item, doubled: item * 2 };
          `,
        },
        'verify-history': {
          type: 'memory',
          operation: 'exec_js',
          depends_on: ['process-item'],
          memory_js: `
            const history = outputs.history["process-item"];
            log("History length:", history ? history.length : 0);
            log("History:", history);

            if (!history || history.length === 0) {
              throw new Error("History should exist and have items");
            }

            return {
              historyLength: history.length,
              allProcessedItems: history.map(h => h.processedItem),
              allDoubledValues: history.map(h => h.doubled)
            };
          `,
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['list-items', 'process-item', 'verify-history'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    expect(result.reviewSummary.issues?.length || 0).toBe(0);
    expect(result.executionStatistics).toBeDefined();

    const verifyStats = result.executionStatistics?.checks.find(
      c => c.checkName === 'verify-history'
    );
    expect(verifyStats).toBeDefined();
    expect(verifyStats?.totalRuns).toBeGreaterThan(0);
  });

  it('should track history across goto loop iterations', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      routing: { max_loops: 3 },
      checks: {
        counter: {
          type: 'memory',
          operation: 'exec_js',
          memory_js: `
            const current = memory.get('counter') || 0;
            const next = current + 1;
            memory.set('counter', next);
            return { iteration: next };
          `,
        },
        'loop-check': {
          type: 'memory',
          operation: 'exec_js',
          depends_on: ['counter'],
          memory_js: `
            const counter = outputs["counter"];
            return { counterValue: counter.iteration };
          `,
          on_success: {
            goto_js: `
              const counter = outputs["counter"];
              return counter.iteration < 3 ? 'counter' : null;
            `,
          },
        },
        'verify-final': {
          type: 'memory',
          operation: 'exec_js',
          depends_on: ['loop-check'],
          memory_js: `
            const counterHistory = outputs.history["counter"];
            const loopHistory = outputs.history["loop-check"];

            log("Counter history:", counterHistory);
            log("Loop history:", loopHistory);

            if (!counterHistory || counterHistory.length === 0) {
              throw new Error("Counter history should exist");
            }

            return {
              counterHistoryLength: counterHistory.length,
              loopHistoryLength: loopHistory ? loopHistory.length : 0,
              allIterations: counterHistory.map(h => h.iteration)
            };
          `,
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['counter', 'loop-check', 'verify-final'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // Should succeed without errors
    expect(result.executionStatistics).toBeDefined();

    const verifyStats = result.executionStatistics?.checks.find(
      c => c.checkName === 'verify-final'
    );
    expect(verifyStats).toBeDefined();
  });

  it('should have current value in outputs and history array in outputs.history', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      routing: { max_loops: 2 },
      checks: {
        increment: {
          type: 'memory',
          operation: 'exec_js',
          memory_js: `
            const count = memory.get('count') || 0;
            memory.set('count', count + 1);
            return count + 1;
          `,
        },
        'check-values': {
          type: 'memory',
          operation: 'exec_js',
          depends_on: ['increment'],
          memory_js: `
            const currentValue = outputs["increment"];
            const historyArray = outputs.history["increment"];

            log("Current value:", currentValue);
            log("History array:", historyArray);

            // Current value should be a number
            if (typeof currentValue !== 'number') {
              throw new Error("Current value should be a number, got: " + typeof currentValue);
            }

            // History should be an array
            if (!Array.isArray(historyArray)) {
              throw new Error("History should be an array");
            }

            return {
              currentValue: currentValue,
              historyLength: historyArray.length,
              isCurrentValueNumber: typeof currentValue === 'number',
              isHistoryArray: Array.isArray(historyArray)
            };
          `,
          on_success: {
            goto_js: `
              const count = memory.get('count');
              return count < 2 ? 'increment' : null;
            `,
          },
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['increment', 'check-values'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    expect(result.reviewSummary.issues?.length || 0).toBe(0);
    expect(result.executionStatistics).toBeDefined();
  });
});
