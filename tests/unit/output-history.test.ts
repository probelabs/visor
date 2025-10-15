import { CommandCheckProvider } from '../../src/providers/command-check-provider';
import { MemoryCheckProvider } from '../../src/providers/memory-check-provider';
import { LogCheckProvider } from '../../src/providers/log-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { ReviewSummary } from '../../src/reviewer';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { MemoryStore } from '../../src/memory-store';

describe('Output History', () => {
  let commandProvider: CommandCheckProvider;
  let memoryProvider: MemoryCheckProvider;
  let logProvider: LogCheckProvider;

  beforeEach(() => {
    commandProvider = new CommandCheckProvider();
    memoryProvider = new MemoryCheckProvider();
    logProvider = new LogCheckProvider();
    MemoryStore.resetInstance();
  });

  const mockPRInfo: PRInfo = {
    number: 123,
    title: 'Test PR',
    body: 'Test description',
    author: 'testuser',
    base: 'main',
    head: 'feature',
    files: [],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  it('should include outputs.history in command provider context', async () => {
    // Create mock output history
    const outputHistory = new Map<string, unknown[]>();
    outputHistory.set('check1', [1, 2, 3]);
    outputHistory.set('check2', ['a', 'b', 'c']);

    // Create mock dependency results
    const dependencyResults = new Map<string, ReviewSummary>();
    dependencyResults.set('check1', { issues: [] } as ReviewSummary);
    dependencyResults.set('check2', { issues: [] } as ReviewSummary);

    const config: CheckProviderConfig = {
      type: 'command',
      exec: 'echo "{{ outputs.history | json }}"',
      __outputHistory: outputHistory,
    };

    const result = await commandProvider.execute(mockPRInfo, config, dependencyResults);

    expect(result).toBeDefined();
    expect(result.issues).toBeDefined();
    expect(result.issues?.length).toBe(0);

    // The command should have had access to outputs.history
    // We can't directly verify the echo output, but we can ensure no errors occurred
  });

  it('should include outputs.history in memory provider context', async () => {
    // Create mock output history
    const outputHistory = new Map<string, unknown[]>();
    outputHistory.set('counter', [1, 2, 3, 4, 5]);

    const config: CheckProviderConfig = {
      type: 'memory',
      operation: 'exec_js',
      memory_js: `
        log('History check:', outputs.history);
        if (!outputs.history || !outputs.history.counter) {
          throw new Error('outputs.history.counter should exist');
        }
        if (outputs.history.counter.length !== 5) {
          throw new Error('Expected 5 items in history');
        }
        return 'History validated: ' + outputs.history.counter.length + ' items';
      `,
      __outputHistory: outputHistory,
    };

    const result = await memoryProvider.execute(mockPRInfo, config);

    expect(result).toBeDefined();

    // Check if there are any issues (errors)
    if (result.issues && result.issues.length > 0) {
      console.log('Issues:', result.issues);
      fail(`Expected no issues, but got: ${JSON.stringify(result.issues, null, 2)}`);
    }

    const resultWithOutput = result as ReviewSummary & { output?: unknown };
    expect(resultWithOutput.output).toBeDefined();
    expect(resultWithOutput.output).toContain('History validated');
    expect(resultWithOutput.output).toContain('5 items');
  });

  it('should include outputs.history in log provider context', async () => {
    // Create mock output history
    const outputHistory = new Map<string, unknown[]>();
    outputHistory.set('test-check', ['first', 'second', 'third']);

    // Create mock dependency results
    const dependencyResults = new Map<string, ReviewSummary>();
    dependencyResults.set('test-check', { issues: [] } as ReviewSummary);

    const config: CheckProviderConfig = {
      type: 'logger',
      message:
        'History: {% for item in outputs.history["test-check"] %}{{ item }}{% unless forloop.last %}, {% endunless %}{% endfor %}',
      __outputHistory: outputHistory,
    };

    const result = await logProvider.execute(mockPRInfo, config, dependencyResults);

    expect(result).toBeDefined();
    const resultWithLog = result as ReviewSummary & { logOutput?: string };
    expect(resultWithLog.logOutput).toBeDefined();
    expect(resultWithLog.logOutput).toContain('History: first, second, third');
  });

  it('should handle empty output history gracefully', async () => {
    // No output history provided
    const config: CheckProviderConfig = {
      type: 'memory',
      operation: 'exec_js',
      memory_js: `
        // outputs.history should exist but be empty
        if (!outputs.history) {
          throw new Error('outputs.history should exist even if empty');
        }
        return 'Empty history check passed';
      `,
    };

    const result = await memoryProvider.execute(mockPRInfo, config);

    expect(result).toBeDefined();
    const resultWithOutput = result as ReviewSummary & { output?: unknown };
    expect(resultWithOutput.output).toContain('Empty history check passed');
  });

  it('should provide separate history for each check', async () => {
    // Create mock output history with different data for different checks
    const outputHistory = new Map<string, unknown[]>();
    outputHistory.set('check-a', [10, 20, 30]);
    outputHistory.set('check-b', ['x', 'y', 'z']);

    const config: CheckProviderConfig = {
      type: 'memory',
      operation: 'exec_js',
      memory_js: `
        if (outputs.history['check-a'].length !== 3) {
          throw new Error('check-a should have 3 items');
        }
        if (outputs.history['check-b'].length !== 3) {
          throw new Error('check-b should have 3 items');
        }
        if (outputs.history['check-a'][0] !== 10) {
          throw new Error('check-a first item should be 10');
        }
        if (outputs.history['check-b'][0] !== 'x') {
          throw new Error('check-b first item should be x');
        }
        return 'Multiple check histories validated';
      `,
      __outputHistory: outputHistory,
    };

    const result = await memoryProvider.execute(mockPRInfo, config);

    expect(result).toBeDefined();
    const resultWithOutput = result as ReviewSummary & { output?: unknown };
    expect(resultWithOutput.output).toContain('Multiple check histories validated');
  });
});
