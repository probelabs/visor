import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

describe('JSON Extraction from Mixed Output', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  it('should extract JSON from end of output with debug logs', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'mixed-output': {
          type: 'command',
          exec: `echo "DEBUG: Starting..."
echo "DEBUG: Processing..."
echo '{"items": ["a", "b", "c"]}'`,
          transform_js: 'output.items',
          forEach: true,
        },
        'process-items': {
          type: 'command',
          exec: 'echo "Item: {{ outputs.mixed-output }}"',
          depends_on: ['mixed-output'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['mixed-output', 'process-items'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // Should successfully process all 3 items
    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'process-items');
    expect(stats?.totalRuns).toBe(3);
    expect(stats?.successfulRuns).toBe(3);
    expect(stats?.failedRuns).toBe(0);
  });

  it('should work with pure JSON output (no debug logs)', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'pure-json': {
          type: 'command',
          exec: 'echo \'["x", "y"]\'',
          forEach: true,
        },
        'process-items': {
          type: 'command',
          exec: 'echo "{{ outputs.pure-json }}"',
          depends_on: ['pure-json'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['pure-json', 'process-items'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'process-items');
    expect(stats?.totalRuns).toBe(2);
    expect(stats?.successfulRuns).toBe(2);
  });

  it('should extract JSON object with nested structure', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'nested-json': {
          type: 'command',
          exec: `echo "Log: Fetching data"
echo '{"data": {"tickets": [{"id": 1}, {"id": 2}]}}'`,
          transform_js: 'output.data.tickets',
          forEach: true,
        },
        'check-id': {
          type: 'command',
          exec: 'echo "ID: {{ outputs.nested-json.id }}"',
          depends_on: ['nested-json'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['nested-json', 'check-id'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'check-id');
    expect(stats?.totalRuns).toBe(2);
    expect(stats?.successfulRuns).toBe(2);
  });

  it('should handle multiline debug output before JSON', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'multiline-debug': {
          type: 'command',
          exec: `echo "DEBUG: Line 1"
echo "DEBUG: Line 2"
echo "DEBUG: Line 3"
echo "INFO: Processing"
echo '["value1", "value2"]'`,
          forEach: true,
        },
        'use-values': {
          type: 'command',
          exec: 'echo "Got: {{ outputs.multiline-debug }}"',
          depends_on: ['multiline-debug'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['multiline-debug', 'use-values'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'use-values');
    expect(stats?.totalRuns).toBe(2);
  });

  it('should return empty array when no valid JSON found', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'no-json': {
          type: 'command',
          exec: 'echo "Just plain text, no JSON here"',
          forEach: true,
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['no-json'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // When forEach is set but no array output, it should handle gracefully
    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'no-json');
    expect(stats).toBeDefined();
  });

  it('should extract array JSON correctly', async () => {
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'array-output': {
          type: 'command',
          exec: `echo "Fetching..."
echo '[1, 2, 3, 4, 5]'`,
          forEach: true,
        },
        'process-numbers': {
          type: 'command',
          exec: 'echo "Number: {{ outputs.array-output }}"',
          depends_on: ['array-output'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['array-output', 'process-numbers'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    const stats = result.executionStatistics?.checks!.find(c => c.checkName === 'process-numbers');
    expect(stats?.totalRuns).toBe(5);
    expect(stats?.successfulRuns).toBe(5);
  });

  it('should handle JIRA-style output with DEBUG lines and transform_js extracting nested array', async () => {
    // This test matches the exact use case from the JIRA ticket fetcher:
    // - Command outputs DEBUG lines (JQL, LIMIT, etc.)
    // - Followed by JSON object with nested tickets array
    // - transform_js extracts the tickets array: output.tickets
    // - forEach iterates over each ticket
    const config: Partial<VisorConfig> = {
      version: '1.0',
      checks: {
        'fetch-tickets': {
          type: 'command',
          exec: `echo "DEBUG: JQL=project = \\"TT\\" AND status != Closed"
echo "DEBUG: LIMIT=10"
echo '{"query":"project = \\"TT\\"","totalTickets":3,"tickets":[{"key":"TT-1","summary":"Bug 1"},{"key":"TT-2","summary":"Bug 2"},{"key":"TT-3","summary":"Bug 3"}]}'`,
          transform_js: 'output.tickets',
          forEach: true,
        },
        'analyze-ticket': {
          type: 'command',
          exec: 'echo "Analyzing: {{ outputs.fetch-tickets.key }} - {{ outputs.fetch-tickets.summary }}"',
          depends_on: ['fetch-tickets'],
        },
      },
    };

    const result = await engine.executeChecks({
      checks: ['fetch-tickets', 'analyze-ticket'],
      config: config as VisorConfig,
      workingDirectory: process.cwd(),
    });

    // Should extract 3 tickets from the JSON despite DEBUG lines
    const fetchStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'fetch-tickets'
    );
    expect(fetchStats?.totalRuns).toBe(1);
    expect(fetchStats?.successfulRuns).toBe(1);

    // Should process all 3 tickets - this is the key assertion
    const analyzeStats = result.executionStatistics?.checks!.find(
      c => c.checkName === 'analyze-ticket'
    );
    expect(analyzeStats?.totalRuns).toBe(3);
    expect(analyzeStats?.successfulRuns).toBe(3);
    expect(analyzeStats?.failedRuns).toBe(0);

    // Verify no execution errors (JSON extraction worked)
    const allIssues = result.reviewSummary.issues || [];
    const hasErrors = allIssues.some((issue: any) => issue.severity === 'error');
    expect(hasErrors).toBe(false);
  });
});
