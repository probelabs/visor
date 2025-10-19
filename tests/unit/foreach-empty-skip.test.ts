import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('forEach Empty Array Skip', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it('should skip dependent check when forEach returns empty array', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          exec: 'echo "[]"',
          forEach: true,
        },
        'process-ticket': {
          type: 'command',
          exec: 'echo "Processing ticket: {{ outputs.fetch-tickets }}"',
          depends_on: ['fetch-tickets'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'process-ticket'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // fetch-tickets should complete successfully with empty array
    const fetchStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'fetch-tickets'
    );
    expect(fetchStats).toBeDefined();
    expect(fetchStats?.skipped).toBe(false);

    // process-ticket should NOT be executed (no runs)
    const processStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'process-ticket'
    );
    expect(processStats).toBeDefined();
    expect(processStats?.totalRuns).toBe(0);

    // Should have no issues
    const allIssues = result.reviewSummary.issues || [];
    expect(allIssues.length).toBe(0);
  });

  it('should propagate empty forEach down the chain', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          exec: 'echo "[]"',
          forEach: true,
        },
        'process-ticket': {
          type: 'command',
          exec: 'echo "ticket: {{ outputs.fetch-tickets }}"',
          depends_on: ['fetch-tickets'],
        },
        'notify-ticket': {
          type: 'command',
          exec: 'echo "notifying: {{ outputs.process-ticket }}"',
          depends_on: ['process-ticket'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'process-ticket', 'notify-ticket'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // fetch-tickets should complete
    const fetchStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'fetch-tickets'
    );
    expect(fetchStats?.skipped).toBe(false);

    // process-ticket should NOT run (0 runs)
    const processStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'process-ticket'
    );
    expect(processStats?.totalRuns).toBe(0);

    // notify-ticket should also NOT run because process-ticket returned empty
    const notifyStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'notify-ticket'
    );
    expect(notifyStats?.totalRuns).toBe(0);
  });

  it('should handle empty array with transform_js', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'fetch-data': {
          type: 'command',
          exec: 'echo \'{"items": []}\'',
          transform_js: 'output.items',
          forEach: true,
        },
        'process-data': {
          type: 'command',
          exec: 'echo "data: {{ outputs.fetch-data }}"',
          depends_on: ['fetch-data'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-data', 'process-data'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // fetch-data should complete
    const fetchStats = result.executionStatistics?.checks!.find(c => c.checkName === 'fetch-data');
    expect(fetchStats?.skipped).toBe(false);

    // process-data should NOT run
    const processStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'process-data'
    );
    expect(processStats?.totalRuns).toBe(0);
  });

  it('should run dependent check when forEach returns non-empty array', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          exec: 'echo \'["TICKET-1", "TICKET-2"]\'',
          forEach: true,
        },
        'process-ticket': {
          type: 'command',
          exec: 'echo "Processing: {{ outputs.fetch-tickets }}"',
          depends_on: ['fetch-tickets'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'process-ticket'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // fetch-tickets should complete
    const fetchStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'fetch-tickets'
    );
    expect(fetchStats?.skipped).toBe(false);

    // process-ticket SHOULD run 2 times (once per ticket)
    const processStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'process-ticket'
    );
    expect(processStats?.totalRuns).toBe(2);
  });
});
