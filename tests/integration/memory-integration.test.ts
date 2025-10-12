import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { MemoryStore } from '../../src/memory-store';
import { VisorConfig } from '../../src/types/config';
import fs from 'fs/promises';
import path from 'path';

describe('Memory Integration Tests', () => {
  let engine: CheckExecutionEngine;
  let testDir: string;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
    MemoryStore.resetInstance();
    testDir = path.join(__dirname, '../fixtures/memory-integration-test');
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Basic Operations', () => {
    it('should execute set and get operations', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
          namespace: 'default',
        },
        checks: {
          'set-value': {
            type: 'memory',
            operation: 'set',
            key: 'test-key',
            value: 'test-value',
          },
          'get-value': {
            type: 'memory',
            operation: 'get',
            key: 'test-key',
            depends_on: ['set-value'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['set-value', 'get-value'],
        config,
        outputFormat: 'json',
      });

      // Verify via memory store
      const store = MemoryStore.getInstance();
      expect(store.get('test-key')).toBe('test-value');
    });

    it('should execute append operations', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'append-1': {
            type: 'memory',
            operation: 'append',
            key: 'items',
            value: 'item1',
          },
          'append-2': {
            type: 'memory',
            operation: 'append',
            key: 'items',
            value: 'item2',
            depends_on: ['append-1'],
          },
          'append-3': {
            type: 'memory',
            operation: 'append',
            key: 'items',
            value: 'item3',
            depends_on: ['append-2'],
          },
          'get-items': {
            type: 'memory',
            operation: 'get',
            key: 'items',
            depends_on: ['append-3'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['append-1', 'append-2', 'append-3', 'get-items'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      expect(store.get('items')).toEqual(['item1', 'item2', 'item3']);
    });
  });

  describe('Retry Counter with goto', () => {
    it('should increment retry counter and stop after limit', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'init-retry': {
            type: 'memory',
            operation: 'set',
            key: 'retry_count',
            value: 0,
          },
          'check-task': {
            type: 'noop',
            depends_on: ['init-retry'],
            fail_if: 'true', // Always fail for testing
            on_fail: {
              run: ['increment-retry', 'check-limit'],
            },
          },
          'increment-retry': {
            type: 'memory',
            operation: 'set',
            key: 'retry_count',
            value_js: 'memory.get("retry_count") + 1',
          },
          'check-limit': {
            type: 'noop',
            depends_on: ['increment-retry'],
            fail_if: 'memory.get("retry_count") >= 3',
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['init-retry', 'check-task', 'increment-retry', 'check-limit'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      const retryCount = store.get('retry_count');
      expect(retryCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Namespace Isolation', () => {
    it('should isolate data by namespace', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
          namespace: 'default',
        },
        checks: {
          'set-default': {
            type: 'memory',
            operation: 'set',
            key: 'counter',
            value: 10,
          },
          'set-prod': {
            type: 'memory',
            operation: 'set',
            key: 'counter',
            value: 100,
            namespace: 'production',
          },
          'set-stage': {
            type: 'memory',
            operation: 'set',
            key: 'counter',
            value: 50,
            namespace: 'staging',
          },
          'get-default': {
            type: 'memory',
            operation: 'get',
            key: 'counter',
            depends_on: ['set-default'],
          },
          'get-prod': {
            type: 'memory',
            operation: 'get',
            key: 'counter',
            namespace: 'production',
            depends_on: ['set-prod'],
          },
          'get-stage': {
            type: 'memory',
            operation: 'get',
            key: 'counter',
            namespace: 'staging',
            depends_on: ['set-stage'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['set-default', 'set-prod', 'set-stage', 'get-default', 'get-prod', 'get-stage'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      expect(store.get('counter', 'default')).toBe(10);
      expect(store.get('counter', 'production')).toBe(100);
      expect(store.get('counter', 'staging')).toBe(50);
    });
  });

  describe('File Persistence', () => {
    it('should persist data to JSON file', async () => {
      const file = path.join(testDir, 'memory.json');

      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'file',
          file,
          format: 'json',
          auto_save: true,
        },
        checks: {
          'set-data': {
            type: 'memory',
            operation: 'set',
            key: 'persisted',
            value: 'this should persist',
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['set-data'],
        config,
        outputFormat: 'json',
      });

      // Verify file was created
      const content = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(content);
      expect(data.default.persisted).toBe('this should persist');
    });

    it('should load data from JSON file', async () => {
      const file = path.join(testDir, 'preload.json');

      // Create pre-existing data
      await fs.mkdir(testDir, { recursive: true });
      const preloadData = {
        default: {
          preloaded: 'existing value',
        },
      };
      await fs.writeFile(file, JSON.stringify(preloadData), 'utf-8');

      // Reset and load
      MemoryStore.resetInstance();

      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'file',
          file,
          format: 'json',
          auto_load: true,
        },
        checks: {
          'get-preloaded': {
            type: 'memory',
            operation: 'get',
            key: 'preloaded',
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['get-preloaded'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      expect(store.get('preloaded')).toBe('existing value');
    });

    it('should persist data to CSV file', async () => {
      const file = path.join(testDir, 'memory.csv');

      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'file',
          file,
          format: 'csv',
          auto_save: true,
        },
        checks: {
          'set-string': {
            type: 'memory',
            operation: 'set',
            key: 'string',
            value: 'text',
          },
          'set-number': {
            type: 'memory',
            operation: 'set',
            key: 'number',
            value: 42,
          },
          'append-items': {
            type: 'memory',
            operation: 'append',
            key: 'items',
            value: 'a',
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['set-string', 'set-number', 'append-items'],
        config,
        outputFormat: 'json',
      });

      // Verify CSV was created
      const content = await fs.readFile(file, 'utf-8');
      expect(content).toContain('namespace,key,value,type');
      expect(content).toContain('string');
      expect(content).toContain('number');
      expect(content).toContain('items');
    });
  });

  describe('Access from fail_if', () => {
    it('should access memory in fail_if expression', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'set-counter': {
            type: 'memory',
            operation: 'set',
            key: 'error_count',
            value: 5,
          },
          'check-errors': {
            type: 'noop',
            depends_on: ['set-counter'],
            fail_if: 'memory.get("error_count") > 3',
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['set-counter', 'check-errors'],
        config,
        outputFormat: 'json',
      });

      // check-errors should fail because error_count (5) > 3
      expect(result.failureConditions).toBeDefined();
      expect(result.failureConditions?.some(fc => fc.failed === true)).toBe(true);
    });
  });

  describe('Access from value_js', () => {
    it('should access dependency outputs in value_js', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'command-check': {
            type: 'command',
            exec: 'echo 42',
            transform_js: 'parseInt(output.trim())',
          },
          'store-output': {
            type: 'memory',
            operation: 'set',
            key: 'command_result',
            value_js: 'outputs["command-check"]',
            depends_on: ['command-check'],
          },
          'get-result': {
            type: 'memory',
            operation: 'get',
            key: 'command_result',
            depends_on: ['store-output'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['command-check', 'store-output', 'get-result'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      expect(store.get('command_result')).toBe(42);
    });

    it('should access PR info in value_js', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'store-branch': {
            type: 'memory',
            operation: 'set',
            key: 'current_branch',
            value_js: 'pr.head || "unknown"',
          },
          'get-branch': {
            type: 'memory',
            operation: 'get',
            key: 'current_branch',
            depends_on: ['store-branch'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['store-branch', 'get-branch'],
        config,
        outputFormat: 'json',
      });

      // Should have stored the branch name
      const store = MemoryStore.getInstance();
      expect(store.get('branch')).toBeDefined();
    });
  });

  describe('Complex Workflows', () => {
    it('should implement a workflow state machine', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'init-state': {
            type: 'memory',
            operation: 'set',
            key: 'workflow_state',
            value: 'pending',
          },
          step1: {
            type: 'noop',
            depends_on: ['init-state'],
            on_success: {
              run: ['set-state-step1'],
            },
          },
          'set-state-step1': {
            type: 'memory',
            operation: 'set',
            key: 'workflow_state',
            value: 'step1_complete',
          },
          step2: {
            type: 'noop',
            depends_on: ['set-state-step1'],
            on_success: {
              run: ['set-state-step2'],
            },
          },
          'set-state-step2': {
            type: 'memory',
            operation: 'set',
            key: 'workflow_state',
            value: 'step2_complete',
          },
          'get-final-state': {
            type: 'memory',
            operation: 'get',
            key: 'workflow_state',
            depends_on: ['set-state-step2'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: [
          'init-state',
          'step1',
          'set-state-step1',
          'step2',
          'set-state-step2',
          'get-final-state',
        ],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      expect(store.get('state')).toBe('step2_complete');
    });

    it('should collect errors from multiple checks', async () => {
      const config: VisorConfig = {
        version: '1.0',
        memory: {
          storage: 'memory',
        },
        checks: {
          'init-errors': {
            type: 'memory',
            operation: 'set',
            key: 'errors',
            value: [],
          },
          check1: {
            type: 'command',
            exec: 'exit 1',
            depends_on: ['init-errors'],
            on_fail: {
              run: ['log-error1'],
            },
          },
          'log-error1': {
            type: 'memory',
            operation: 'append',
            key: 'errors',
            value: 'check1 failed',
          },
          check2: {
            type: 'command',
            exec: 'exit 1',
            depends_on: ['init-errors'],
            on_fail: {
              run: ['log-error2'],
            },
          },
          'log-error2': {
            type: 'memory',
            operation: 'append',
            key: 'errors',
            value: 'check2 failed',
          },
          'get-errors': {
            type: 'memory',
            operation: 'get',
            key: 'errors',
            depends_on: ['log-error1', 'log-error2'],
          },
        },
        output: {
          pr_comment: {
            format: 'json',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      await engine.executeChecks({
        checks: ['init-errors', 'check1', 'log-error1', 'check2', 'log-error2', 'get-errors'],
        config,
        outputFormat: 'json',
      });

      const store = MemoryStore.getInstance();
      const errors = store.get('errors');
      expect(Array.isArray(errors)).toBe(true);
      expect((errors as string[]).length).toBeGreaterThan(0);
    });
  });
});
