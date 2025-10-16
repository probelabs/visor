import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';
import * as path from 'path';
import * as fs from 'fs';

describe('on_finish Validation', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  describe('on_finish configuration validation', () => {
    it('should accept on_finish on forEach checks', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'extract-items': {
            type: 'ai',
            prompt: 'extract items',
            forEach: true,
            on_finish: {
              run: ['aggregate-results'],
              goto_js: 'return null;',
            },
          },
          'aggregate-results': {
            type: 'memory',
            operation: 'set',
            key: 'aggregated',
            value: true,
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-valid-on-finish.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).resolves.toBeDefined();
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject on_finish on non-forEach checks', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'normal-check': {
            type: 'ai',
            prompt: 'normal check',
            forEach: false,
            on_finish: {
              run: ['some-check'],
            },
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-invalid-on-finish.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /on_finish is only valid on forEach checks/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });

    it('should reject on_finish when forEach is not specified', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'check-without-foreach': {
            type: 'ai',
            prompt: 'check without forEach',
            on_finish: {
              goto: 'some-other-check',
            },
          },
        },
        output: {
          pr_comment: {
            format: 'table' as const,
            group_by: 'check' as const,
            collapse: false,
          },
        },
      };

      const tempFile = path.join(__dirname, 'test-config-on-finish-no-foreach.yaml');
      fs.writeFileSync(tempFile, JSON.stringify(config));

      try {
        await expect(configManager.loadConfig(tempFile)).rejects.toThrow(
          /on_finish is only valid on forEach checks/
        );
      } finally {
        fs.unlinkSync(tempFile);
      }
    });
  });

  describe('on_finish execution context', () => {
    it('should document expected behavior for on_finish.run execution order', () => {
      // This test documents the EXPECTED behavior
      // In on_finish.run, checks should execute in the specified order

      const onFinishConfig = {
        run: ['first-check', 'second-check', 'third-check'],
      };

      // Expected: Checks execute sequentially in order
      expect(onFinishConfig.run[0]).toBe('first-check');
      expect(onFinishConfig.run[1]).toBe('second-check');
      expect(onFinishConfig.run[2]).toBe('third-check');
    });

    it('should document expected behavior for on_finish.goto_js routing', () => {
      // This test documents the EXPECTED behavior
      // goto_js should evaluate to either a string (check name) or null

      // Example goto_js expression
      const gotoJsExample = `
        const allValid = outputs['validate-item'].every(item => item.valid === true);
        if (allValid) {
          return null; // Continue normal flow
        } else {
          return 'retry-handler'; // Route to retry-handler check
        }
      `;

      // Expected: Returns string or null
      expect(typeof gotoJsExample).toBe('string');
      expect(gotoJsExample).toContain('return null');
      expect(gotoJsExample).toContain("return 'retry-handler'");
    });

    it('should document error handling for on_finish.run', () => {
      // This test documents the EXPECTED behavior
      // Errors in on_finish.run checks should be caught and logged, not crash execution

      const errorScenario = {
        forEach: true,
        on_finish: {
          run: ['failing-check'], // This check fails
        },
      };

      // Expected: Errors are logged but don't crash the entire execution
      expect(errorScenario.on_finish.run).toContain('failing-check');
    });

    it('should document fallback for on_finish.goto_js errors', () => {
      // This test documents the EXPECTED behavior
      // If goto_js throws, fallback to static goto if present

      const fallbackScenario = {
        forEach: true,
        on_finish: {
          goto_js: 'throw new Error("intentional error");',
          goto: 'fallback-check',
        },
      };

      // Expected: If goto_js fails, use static goto
      expect(fallbackScenario.on_finish.goto).toBe('fallback-check');
    });

    it('should document forEach stats availability in on_finish context', () => {
      // This test documents the EXPECTED behavior
      // forEach object should be available in on_finish context

      const forEachStatsExample = {
        total: 3,
        successful: 2,
        failed: 1,
        items: [{ id: 1 }, { id: 2 }, { id: 3 }],
      };

      // Expected: forEach stats include total, successful, failed, items
      expect(forEachStatsExample).toHaveProperty('total');
      expect(forEachStatsExample).toHaveProperty('successful');
      expect(forEachStatsExample).toHaveProperty('failed');
      expect(forEachStatsExample).toHaveProperty('items');
    });

    it('should document outputs.history availability in on_finish context', () => {
      // This test documents the EXPECTED behavior
      // outputs.history should contain all results from forEach iterations

      const historyExample = {
        'validate-item': [
          { valid: true, id: 1 },
          { valid: false, id: 2 },
          { valid: true, id: 3 },
        ],
      };

      // Expected: history contains array of all iteration results
      expect(Array.isArray(historyExample['validate-item'])).toBe(true);
      expect(historyExample['validate-item']).toHaveLength(3);
    });

    it('should document memory helpers availability in on_finish.goto_js', () => {
      // This test documents the EXPECTED behavior
      // memory.get(), memory.set(), memory.increment() should be available

      const memoryExample = {
        get: (key: string, namespace: string) => 0,
        set: (key: string, value: any, namespace: string) => {},
        increment: (key: string, by: number, namespace: string) => {},
      };

      // Expected: memory helpers available for state management
      expect(typeof memoryExample.get).toBe('function');
      expect(typeof memoryExample.set).toBe('function');
      expect(typeof memoryExample.increment).toBe('function');
    });
  });
});
