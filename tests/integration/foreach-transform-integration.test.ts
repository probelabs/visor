import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { PRInfo } from '../../src/pr-analyzer';
import { VisorConfig } from '../../src/types/config';

describe('forEach with transform_js integration', () => {
  let registry: CheckProviderRegistry;

  beforeEach(() => {
    registry = CheckProviderRegistry.getInstance();
  });

  it('should properly propagate forEach items to dependent checks when using transform_js', async () => {
    // Track what the dependent check receives
    const capturedOutputs: any[] = [];

    // Create a mock provider to capture dependency results
    const mockProvider = {
      execute: jest.fn(async (prInfo, config, dependencyResults) => {
        // Capture what this check receives from dependencies
        if (dependencyResults && dependencyResults.has('fetch-items')) {
          const fetchResult = dependencyResults.get('fetch-items');
          // The buildOutputContext method extracts the output field
          const outputs: Record<string, unknown> = {};
          for (const [checkName, result] of dependencyResults) {
            outputs[checkName] = (result as any).output !== undefined ? (result as any).output : result;
          }
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

    const prInfo: PRInfo = {
      number: 1,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feature',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };

    // Mock execSync for the command provider
    const originalExecSync = require('child_process').execSync;
    require('child_process').execSync = jest.fn((cmd: string) => {
      if (cmd.includes('[{"id":1')) {
        return Buffer.from('[{"id":1,"name":"item1"},{"id":2,"name":"item2"}]');
      }
      return Buffer.from('');
    });

    try {
      const engine = new CheckExecutionEngine();

      // Execute the checks
      let result;
      try {
        result = await engine.executeChecks({
          checks: ['process-items'],
          config,
        });
      } catch (error) {
        console.error('Execution error:', error);
        throw error;
      }

      console.log('Test result:', result ? 'Got result' : 'No result');
      console.log('Mock provider calls:', mockProvider.execute.mock.calls.length);
      console.log('Captured outputs:', capturedOutputs);

      // Verify the dependent check was called twice (once for each forEach item)
      expect(mockProvider.execute).toHaveBeenCalledTimes(2);

      // Verify each call received the individual item wrapped properly
      expect(capturedOutputs).toHaveLength(2);
      expect(capturedOutputs[0]).toEqual({ id: 1, name: 'item1' });
      expect(capturedOutputs[1]).toEqual({ id: 2, name: 'item2' });

    } finally {
      require('child_process').execSync = originalExecSync;
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

    const prInfo: PRInfo = {
      number: 1,
      title: 'Test',
      body: '',
      author: 'test',
      base: 'main',
      head: 'feature',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
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
        checks: ['process-data'],
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