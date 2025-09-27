import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { VisorConfig } from '../../src/types/config';
import { execSync } from 'child_process';

jest.mock('child_process');

describe('forEach with transform_js integration', () => {
  let registry: CheckProviderRegistry;

  beforeEach(() => {
    registry = CheckProviderRegistry.getInstance();
  });

  it('should properly propagate forEach items to dependent checks when using transform_js', async () => {
    // Override console.log temporarily to see debug output
    const originalLog = console.log;
    const logs: any[] = [];
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };

    // Track what the dependent check receives
    const capturedOutputs: any[] = [];

    // Create a mock provider to capture dependency results
    const mockProvider = {
      execute: jest.fn(async (prInfo, config, dependencyResults) => {
        console.log(
          'Mock provider called with dependencies:',
          dependencyResults ? Array.from(dependencyResults.keys()) : 'none'
        );

        // Capture what this check receives from dependencies
        if (dependencyResults && dependencyResults.has('fetch-items')) {
          // The buildOutputContext method extracts the output field
          const outputs: Record<string, unknown> = {};
          for (const [checkName, result] of dependencyResults) {
            console.log(`Dependency ${checkName}:`, result);
            outputs[checkName] =
              (result as any).output !== undefined ? (result as any).output : result;
          }
          console.log('Extracted fetch-items:', outputs['fetch-items']);
          capturedOutputs.push(outputs['fetch-items']);
        }
        return { issues: [] };
      }),
      getName: () => 'test-provider',
      getSupportedConfigKeys: () => ['type', 'depends_on'],
    };

    // Override the noop provider with our mock
    const originalNoop = (registry as any).providers.get('noop');
    (registry as any).providers.set('noop', mockProvider);

    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-items': {
          type: 'command',
          exec: 'echo \'[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]\'',
          transform_js: 'JSON.parse(output)',
          forEach: true,
        },
        'process-items': {
          type: 'noop' as any,
          depends_on: ['fetch-items'],
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    // Mock execSync for the command provider - override the global mock from setup.ts
    console.log('execSync mock before:', (execSync as jest.Mock).getMockImplementation());
    (execSync as jest.Mock).mockImplementation((cmd: string, options?: any) => {
      console.log('execSync called with command:', cmd);
      console.log('execSync options:', options);
      // Always return the expected JSON for any echo command
      const result = '[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]';
      console.log('Returning:', result);
      return Buffer.from(result);
    });
    console.log('execSync mock after:', (execSync as jest.Mock).getMockImplementation());

    try {
      const engine = new CheckExecutionEngine();

      // Execute the checks - need to run both fetch-items and process-items
      try {
        const results = await engine.executeChecks({
          checks: ['fetch-items', 'process-items'],
          config,
        });
        console.log('Results:', results);

        // Log the fetch-items result
        const fetchResult =
          (results as any).checkResults?.['fetch-items'] ||
          (results as any).results?.get('fetch-items');
        console.log('fetch-items result:', JSON.stringify(fetchResult, null, 2));

        console.log('Mock provider calls:', mockProvider.execute.mock.calls.length);
        console.log('Captured outputs:', capturedOutputs);
      } catch (error) {
        console.error('Execution error:', error);
        throw error;
      }

      // Log what we actually got
      console.log('capturedOutputs detail:', JSON.stringify(capturedOutputs, null, 2));

      // Verify the dependent check was called twice (once for each forEach item)
      expect(mockProvider.execute).toHaveBeenCalledTimes(2);

      // Verify each call received the individual item wrapped properly
      expect(capturedOutputs).toHaveLength(2);
      expect(capturedOutputs[0]).toEqual({ id: 1, name: 'item1' });
      expect(capturedOutputs[1]).toEqual({ id: 2, name: 'item2' });
    } finally {
      // Print logs for debugging
      console.log = originalLog;
      process.stderr.write(`Test logs: ${JSON.stringify(logs, null, 2)}\n`);

      // Reset the mock
      (execSync as jest.Mock).mockReset();
      // Restore the original noop provider
      (registry as any).providers.set('noop', originalNoop);
    }
  });

  it('should handle forEach with transform_js in command provider', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'fetch-data': {
          type: 'command',
          exec: 'echo \'{"items":[{"id":1},{"id":2}]}\'',
          transform_js: 'JSON.parse(output).items',
          forEach: true,
        },
        'process-data': {
          type: 'command',
          depends_on: ['fetch-data'],
          exec: 'echo "ID:{{ outputs[\\"fetch-data\\"].id }}"',
        },
      },
      output: {
        pr_comment: {
          format: 'markdown',
          group_by: 'check',
          collapse: false,
        },
      },
    };

    // Track executed commands
    const executedCommands: string[] = [];
    const originalExecSync = require('child_process').execSync;
    require('child_process').execSync = jest.fn((cmd: string) => {
      executedCommands.push(cmd);

      if (cmd.includes('{"items":[')) {
        return Buffer.from('{"items":[{"id":1},{"id":2}]}');
      }
      // Return the command to see what was rendered
      return Buffer.from(cmd);
    });

    try {
      const engine = new CheckExecutionEngine();

      await engine.executeChecks({
        checks: ['fetch-data', 'process-data'],
        config,
      });

      // Should have executed process-data twice
      const processCommands = executedCommands.filter(cmd => cmd.includes('ID:'));
      expect(processCommands).toHaveLength(2);

      // Verify the IDs were properly extracted
      expect(processCommands[0]).toContain('ID:1');
      expect(processCommands[1]).toContain('ID:2');
    } finally {
      require('child_process').execSync = originalExecSync;
    }
  });
});
