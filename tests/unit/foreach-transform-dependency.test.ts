import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';
import { PRInfo } from '../../src/types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('forEach with transform_js dependency propagation', () => {
  let tempDir: string;
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-test-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should propagate individual forEach items to dependent checks when using transform_js', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-items': {
          type: 'command',
          exec: 'echo \'[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]\'',
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'process-item': {
          type: 'command',
          depends_on: ['fetch-items'],
          // This should receive individual items, not the entire array
          exec: 'echo "Processing item: {{ outputs[\\"fetch-items\\"] | json }}"',
        },
      },
      output: {
        pr_comment: {
          enabled: false,
        },
      },
    };

    const prInfo: PRInfo = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock the command provider to capture what it receives
    const executedCommands: string[] = [];
    const originalExec = require('child_process').execSync;
    require('child_process').execSync = jest.fn((cmd: string) => {
      executedCommands.push(cmd);
      if (cmd.includes('echo \'[{"id":1')) {
        return Buffer.from('[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]');
      }
      // Return the command itself to see what was templated
      return Buffer.from(cmd);
    });

    try {
      // Initialize engine with config
      engine = new CheckExecutionEngine(tempDir, tempDir, config);

      const result = await engine.executeGroupedChecks(
        prInfo,
        ['process-item']
      );

      // The process-item check should have been executed twice (once for each item)
      const processCommands = executedCommands.filter(cmd => cmd.includes('Processing item'));
      expect(processCommands).toHaveLength(2);

      // Check that we have results
      expect(result).toBeDefined();
    } finally {
      require('child_process').execSync = originalExec;
    }
  });

  it('should wrap forEach items in ReviewSummary with output field', async () => {
    // Create a mock provider that inspects the dependency results
    const mockProvider = jest.fn();
    const capturedDependencyResults: any[] = [];

    mockProvider.mockImplementation((_prInfo, _config, dependencyResults) => {
      if (dependencyResults && dependencyResults.has('fetch-items')) {
        const fetchResult = dependencyResults.get('fetch-items');
        capturedDependencyResults.push(fetchResult);
      }
      return Promise.resolve({ issues: [] });
    });

    // Register the mock provider
    const { CheckProviderRegistry } = require('../../src/providers/check-provider-registry');
    CheckProviderRegistry.register('test', mockProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-items': {
          type: 'command',
          exec: 'echo \'[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]\'',
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'process-item': {
          type: 'test',
          depends_on: ['fetch-items'],
        },
      },
      output: {
        pr_comment: {
          enabled: false,
        },
      },
    };

    const prInfo: PRInfo = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Initialize engine with config
    engine = new CheckExecutionEngine(tempDir, tempDir, config);

    const result = await engine.executeGroupedChecks(
      prInfo,
      ['process-item']
    );

    // Should have been called twice (once for each forEach item)
    expect(capturedDependencyResults).toHaveLength(2);

    // Each call should have the dependency result wrapped with an output field
    expect(capturedDependencyResults[0]).toHaveProperty('output');
    expect(capturedDependencyResults[0].output).toEqual({ id: 1, name: 'item1' });

    expect(capturedDependencyResults[1]).toHaveProperty('output');
    expect(capturedDependencyResults[1].output).toEqual({ id: 2, name: 'item2' });
  });
});