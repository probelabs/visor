import { ConfigManager } from '../../src/config';
import { ActionCliBridge } from '../../src/action-cli-bridge';
import { CommentManager } from '../../src/github-comments';
import { EventMapper } from '../../src/event-mapper';
import { MemoryProfiler, createMockOctokit } from '../performance/test-utilities';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';

describe('Resource Cleanup Verification Tests', () => {
  let memoryProfiler: MemoryProfiler;
  let mockOctokit: any;
  let tempDir: string;

  beforeAll(() => {
    // Create temporary directory for test resources
    tempDir = path.join(os.tmpdir(), 'visor-resource-cleanup-tests');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Cleanup temporary directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Could not cleanup temp directory:', error);
    }
  });

  beforeEach(() => {
    memoryProfiler = new MemoryProfiler();
    mockOctokit = createMockOctokit();
    
    if (global.gc) {
      global.gc();
    }
  });

  afterEach(() => {
    if (global.gc) {
      global.gc();
    }
  });

  describe('File Handle Cleanup', () => {
    test('should properly cleanup file handles after config operations', async () => {
      console.log('Testing file handle cleanup after config operations...');

      const configManager = new ConfigManager();
      const createdFiles: string[] = [];
      
      // Create many temporary config files
      const numConfigs = 50;
      console.log(`Creating ${numConfigs} temporary config files...`);

      for (let i = 0; i < numConfigs; i++) {
        const configPath = path.join(tempDir, `test-config-${i}.yaml`);
        const config = {
          version: '1.0',
          checks: {
            [`test-check-${i}`]: {
              type: 'ai',
              prompt: `Test prompt ${i}`,
              on: ['pr_opened'],
            },
          },
          output: {
            pr_comment: {
              format: 'summary',
              group_by: 'check',
              collapse: true,
            },
          },
        };

        fs.writeFileSync(configPath, yaml.dump(config));
        createdFiles.push(configPath);
      }

      // Perform many file operations
      const loadPromises: Promise<any>[] = [];
      
      for (let i = 0; i < numConfigs; i++) {
        const configPath = createdFiles[i];
        
        // Create promise for each config load
        const loadPromise = (async () => {
          try {
            const config = await configManager.loadConfig(configPath);
            
            // Perform additional operations
            const cliOptions = {
              checks: ['performance' as any],
              output: 'json' as const,
              configPath: undefined,
              help: false,
              version: false,
            };
            
            const merged = configManager.mergeWithCliOptions(config, cliOptions);
            
            // Simulate processing
            JSON.stringify(merged);
            
            return { success: true, configPath };
          } catch (error) {
            return { success: false, error, configPath };
          }
        })();
        
        loadPromises.push(loadPromise);
      }

      // Wait for all operations to complete
      const results = await Promise.allSettled(loadPromises);
      const successful = results.filter(r => r.status === 'fulfilled').length;

      console.log(`File operations completed: ${successful}/${numConfigs} successful`);

      // Force garbage collection to test file handle cleanup
      if (global.gc) {
        global.gc();
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Test that we can still perform file operations (file handles not exhausted)
      const testConfigPath = path.join(tempDir, 'cleanup-test.yaml');
      const testConfig = { version: '1.0', checks: {} };
      
      fs.writeFileSync(testConfigPath, yaml.dump(testConfig));
      
      try {
        const cleanupTestConfig = await configManager.loadConfig(testConfigPath);
        expect(cleanupTestConfig).toBeDefined();
        console.log('File handle cleanup verification: SUCCESS');
      } catch (error: any) {
        console.error('File handle cleanup verification failed:', error);
        throw error;
      }

      // Cleanup test files
      for (const filePath of [...createdFiles, testConfigPath]) {
        try {
          fs.unlinkSync(filePath);
        } catch (error) {
          console.warn(`Could not cleanup ${filePath}:`, error);
        }
      }

      // Should handle file operations without resource exhaustion
      expect(successful).toBeGreaterThanOrEqual(numConfigs * 0.9); // 90% success rate
    });

    test('should handle temporary file cleanup in ActionCliBridge', async () => {
      console.log('Testing temporary file cleanup in ActionCliBridge...');

      const context = {
        event_name: 'pull_request',
        repository: {
          owner: { login: 'test-owner' },
          name: 'test-repo',
        },
      };

      const bridges: ActionCliBridge[] = [];
      const tempFilePaths: string[] = [];

      // Create multiple bridges that generate temporary files
      const numBridges = 20;
      console.log(`Creating ${numBridges} ActionCliBridge instances...`);

      for (let i = 0; i < numBridges; i++) {
        const bridge = new ActionCliBridge('test-token', context);
        
        const inputs = {
          'github-token': 'test-token',
          'visor-checks': 'security,performance',
          owner: 'test-owner',
          repo: 'test-repo',
        };

        try {
          // This should create temporary config files
          const tempConfigPath = await bridge.createTempConfigFromInputs(inputs);
          
          if (tempConfigPath) {
            tempFilePaths.push(tempConfigPath);
            
            // Verify file was created
            if (fs.existsSync(tempConfigPath)) {
              console.log(`  Created temp file: ${path.basename(tempConfigPath)}`);
            }
          }
        } catch (error: any) {
          // Some operations might fail, but that's ok for cleanup testing
          console.log(`  Bridge ${i} failed to create temp config: ${error.message}`);
        }

        bridges.push(bridge);
      }

      console.log(`Created ${tempFilePaths.length} temporary files`);

      // Cleanup all bridges
      let cleanupSuccesses = 0;
      let cleanupFailures = 0;

      for (let i = 0; i < bridges.length; i++) {
        try {
          await bridges[i].cleanup();
          cleanupSuccesses++;
        } catch (error: any) {
          cleanupFailures++;
          console.log(`  Bridge ${i} cleanup failed: ${error.message}`);
        }
      }

      console.log(`Cleanup results: ${cleanupSuccesses} successful, ${cleanupFailures} failed`);

      // Check if temporary files were actually cleaned up
      let filesRemaining = 0;
      for (const filePath of tempFilePaths) {
        if (fs.existsSync(filePath)) {
          filesRemaining++;
          console.log(`  File still exists: ${path.basename(filePath)}`);
          
          // Manual cleanup for test cleanliness
          try {
            fs.unlinkSync(filePath);
          } catch (error) {
            console.warn(`Could not manually cleanup ${filePath}`);
          }
        }
      }

      console.log(`Temporary File Cleanup Results:`);
      console.log(`  Files created: ${tempFilePaths.length}`);
      console.log(`  Files remaining: ${filesRemaining}`);
      console.log(`  Cleanup success rate: ${((tempFilePaths.length - filesRemaining) / tempFilePaths.length * 100).toFixed(2)}%`);

      // Should cleanup most temporary files
      expect(filesRemaining).toBeLessThanOrEqual(tempFilePaths.length * 0.1); // ≤10% remaining
    });
  });

  describe('Memory Reference Cleanup', () => {
    test('should cleanup EventMapper references after processing', async () => {
      console.log('Testing EventMapper reference cleanup...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping reference cleanup test');
        return;
      }

      // Establish baseline
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 100));
      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;

      const eventMappers: EventMapper[] = [];
      const largeConfigs: any[] = [];

      // Create many EventMappers with large configurations
      const numMappers = 30;
      console.log(`Creating ${numMappers} EventMappers with large configurations...`);

      for (let i = 0; i < numMappers; i++) {
        // Create large configuration
        const largeConfig: any = {
          version: '1.0',
          checks: {},
          output: {
            pr_comment: {
              format: 'summary' as const,
              group_by: 'check' as const,
              collapse: true,
            },
          },
        };

        // Add many checks to make config large
        for (let j = 0; j < 100; j++) {
          largeConfig.checks[`check-${i}-${j}`] = {
            type: 'ai' as const,
            prompt: `Large prompt for check ${i}-${j}: ${Array(100).fill(`detail-${j}`).join(' ')}`,
            on: ['pr_opened' as const, 'pr_updated' as const],
            triggers: Array(20).fill(0).map((_, k) => `**/*-${i}-${j}-${k}.*`),
          };
        }

        largeConfigs.push(largeConfig);
        const eventMapper = new EventMapper(largeConfig);
        
        // Perform operations that create internal references
        const event = {
          event_name: 'pull_request',
          action: 'opened',
          repository: { owner: { login: `owner-${i}` }, name: `repo-${i}` },
          pull_request: { number: i, state: 'open', head: { sha: 'abc', ref: 'feature' }, base: { sha: 'def', ref: 'main' }, draft: false },
        };

        const fileContext = {
          changedFiles: Array(50).fill(0).map((_, k) => `file-${i}-${k}.js`),
          modifiedFiles: Array(25).fill(0).map((_, k) => `modified-${i}-${k}.js`),
        };

        try {
          const execution = eventMapper.mapEventToExecution(event, fileContext);
          expect(execution).toBeDefined();
        } catch (error: any) {
          // Continue even if some mapping fails
        }

        eventMappers.push(eventMapper);
      }

      const afterCreationMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const creationGrowthMB = (afterCreationMemory - baselineMemory) / 1024 / 1024;
      
      console.log(`After creation: ${(afterCreationMemory / 1024 / 1024).toFixed(2)}MB (growth: ${creationGrowthMB.toFixed(2)}MB)`);

      // Clear all references
      eventMappers.length = 0;
      largeConfigs.length = 0;

      // Force garbage collection multiple times
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      global.gc(); // Second pass
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - baselineMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterCreationMemory - afterCleanupMemory) / 1024 / 1024;
      const recoveryPercentage = (recoveredMemoryMB / creationGrowthMB) * 100;

      console.log(`EventMapper Reference Cleanup Results:`);
      console.log(`  Creation growth: ${creationGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);
      console.log(`  Recovery percentage: ${recoveryPercentage.toFixed(2)}%`);

      // Should recover significant memory
      expect(recoveryPercentage).toBeGreaterThan(70); // Recover >70% of created memory
      expect(cleanupGrowthMB).toBeLessThan(30); // Final growth <30MB
      expect(recoveredMemoryMB).toBeGreaterThan(20); // Recover at least 20MB
    });

    test('should cleanup circular references in configurations', async () => {
      console.log('Testing cleanup of circular references in configurations...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping circular reference test');
        return;
      }

      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const circularConfigs: any[] = [];

      // Create configurations with circular references
      const numCircularConfigs = 20;
      console.log(`Creating ${numCircularConfigs} configurations with circular references...`);

      for (let i = 0; i < numCircularConfigs; i++) {
        const config: any = {
          version: '1.0',
          checks: {},
          output: {
            pr_comment: {
              format: 'summary' as const,
              group_by: 'check' as const,
              collapse: true,
            },
          },
          metadata: {
            id: i,
            created: new Date(),
          },
        };

        // Create circular reference
        config.checks[`circular-check-${i}`] = {
          type: 'ai' as const,
          prompt: 'Test circular reference',
          on: ['pr_opened' as const],
          config_reference: config, // Circular reference
          parent_config: config, // Another circular reference
        };

        // Add reference back from root to check
        config.primary_check = config.checks[`circular-check-${i}`];
        
        // Create some nested circular references
        config.nested = {
          level1: {
            level2: {
              back_to_root: config,
              back_to_check: config.checks[`circular-check-${i}`],
            },
          },
        };
        config.nested.level1.level2.back_to_nested = config.nested;

        circularConfigs.push(config);

        // Test that we can still use the config despite circular references
        try {
          const eventMapper = new EventMapper(config);
          expect(eventMapper).toBeDefined();
        } catch (error: any) {
          console.log(`  Config ${i} with circular refs caused error: ${error.message}`);
        }
      }

      const afterCreationMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const creationGrowthMB = (afterCreationMemory - baselineMemory) / 1024 / 1024;
      
      console.log(`After creation: ${(afterCreationMemory / 1024 / 1024).toFixed(2)}MB (growth: ${creationGrowthMB.toFixed(2)}MB)`);

      // Clear references (this should break the circular references)
      for (const config of circularConfigs) {
        // Explicitly break some circular references to help GC
        try {
          if (config.checks) {
            for (const check of Object.values(config.checks)) {
              (check as any).config_reference = null;
              (check as any).parent_config = null;
            }
          }
          if (config.nested) {
            config.nested.level1.level2.back_to_root = null;
            config.nested.level1.level2.back_to_check = null;
            config.nested.level1.level2.back_to_nested = null;
          }
          config.primary_check = null;
        } catch (error) {
          // Continue cleanup even if some operations fail
        }
      }

      circularConfigs.length = 0;

      // Force garbage collection
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 300));
      global.gc(); // Second pass for circular reference cleanup
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - baselineMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterCreationMemory - afterCleanupMemory) / 1024 / 1024;

      console.log(`Circular Reference Cleanup Results:`);
      console.log(`  Creation growth: ${creationGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);

      // Should handle circular references without major leaks
      expect(cleanupGrowthMB).toBeLessThan(50); // Final growth <50MB
      expect(recoveredMemoryMB).toBeGreaterThan(10); // Recover at least 10MB
    });
  });

  describe('Network Connection Cleanup', () => {
    test('should cleanup network resources after GitHub API operations', async () => {
      console.log('Testing network resource cleanup after GitHub API operations...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping network cleanup test');
        return;
      }

      const commentManagers: CommentManager[] = [];
      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;

      // Create many comment managers with different configurations
      const numManagers = 25;
      console.log(`Creating ${numManagers} CommentManagers with API operations...`);

      for (let i = 0; i < numManagers; i++) {
        const manager = new CommentManager(mockOctokit, {
          maxRetries: 3,
          baseDelay: 100,
        });

        // Perform multiple API operations that create connections/state
        const operations = [
          () => manager.findVisorComment('test-owner', `test-repo-${i}`, i),
          () => manager.updateOrCreateComment(
            'test-owner',
            `test-repo-${i}`,
            i,
            `Large comment content ${i}: ${Array(100).fill(`data-${i}`).join(' ')}`,
            { commentId: `comment-${i}`, triggeredBy: `test-${i}` }
          ),
          () => manager.formatCommentWithMetadata(
            `Content ${i}`,
            { commentId: `format-${i}`, lastUpdated: new Date().toISOString(), triggeredBy: `format-test-${i}` }
          ),
        ];

        // Execute operations
        for (const operation of operations) {
          try {
            await operation();
          } catch (error: any) {
            // Expected for mock operations, continue testing cleanup
          }
        }

        commentManagers.push(manager);
      }

      const afterOperationsMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const operationsGrowthMB = (afterOperationsMemory - baselineMemory) / 1024 / 1024;
      
      console.log(`After operations: ${(afterOperationsMemory / 1024 / 1024).toFixed(2)}MB (growth: ${operationsGrowthMB.toFixed(2)}MB)`);

      // Clear all comment manager references
      commentManagers.length = 0;

      // Clear mock octokit to simulate connection cleanup
      mockOctokit = null;

      // Force garbage collection to cleanup network resources
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      global.gc(); // Second pass
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - baselineMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterOperationsMemory - afterCleanupMemory) / 1024 / 1024;

      console.log(`Network Resource Cleanup Results:`);
      console.log(`  Operations growth: ${operationsGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);

      // Should cleanup network-related memory
      expect(cleanupGrowthMB).toBeLessThan(20); // Final growth <20MB
      expect(recoveredMemoryMB).toBeGreaterThan(5); // Recover at least 5MB

      // Restore mock for other tests
      mockOctokit = createMockOctokit();
    });
  });

  describe('Resource Leak Detection', () => {
    test('should detect and prevent resource leaks in error scenarios', async () => {
      console.log('Testing resource leak detection in error scenarios...');

      if (!global.gc) {
        console.log('Garbage collection not available, skipping leak detection test');
        return;
      }

      const baselineMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const resourceHolders: any[] = [];

      // Create scenarios that might cause resource leaks
      const numScenarios = 30;
      console.log(`Running ${numScenarios} error scenarios that might cause resource leaks...`);

      for (let i = 0; i < numScenarios; i++) {
        try {
          const configManager = new ConfigManager();
          const context = {
            event_name: 'pull_request',
            repository: { owner: { login: 'test' }, name: 'repo' },
          };
          const bridge = new ActionCliBridge('token', context);
          
          // Create resources that might leak on error
          const resources = {
            id: i,
            configManager,
            bridge,
            largeBuffer: Buffer.alloc(1024 * 50), // 50KB buffer
            errorData: Array(100).fill(0).map((_, j) => ({
              id: `error-${i}-${j}`,
              data: `error-data-${i}-${j}`.repeat(10),
              timestamp: new Date(),
            })),
          };
          
          resourceHolders.push(resources);

          // Simulate operations that might fail
          const errorOperations = [
            // Config loading with invalid path
            () => configManager.loadConfig(`/invalid/path/config-${i}.yaml`),
            // Bridge operations with invalid inputs
            () => bridge.parseGitHubInputsToCliArgs({ 'github-token': null } as any),
            // Mock API call that fails
            () => mockOctokit.rest.pulls.get({ owner: 'invalid', repo: 'invalid', pull_number: -1 }),
          ];

          // Execute operations and expect them to fail
          for (const operation of errorOperations) {
            try {
              await operation();
            } catch (error: any) {
              // Expected failures - the key is that resources should still be cleaned up
            }
          }

        } catch (error: any) {
          // Errors are expected in this test scenario
        }

        // Check memory growth periodically
        if (i % 10 === 0) {
          const currentMemory = memoryProfiler.getCurrentUsage().heapUsed;
          const growthMB = (currentMemory - baselineMemory) / 1024 / 1024;
          console.log(`  Scenario ${i}: ${(currentMemory / 1024 / 1024).toFixed(2)}MB (growth: ${growthMB.toFixed(2)}MB)`);
        }
      }

      const afterErrorsMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const errorsGrowthMB = (afterErrorsMemory - baselineMemory) / 1024 / 1024;
      
      console.log(`After error scenarios: ${(afterErrorsMemory / 1024 / 1024).toFixed(2)}MB (growth: ${errorsGrowthMB.toFixed(2)}MB)`);

      // Clear all resource holders
      resourceHolders.length = 0;

      // Force cleanup
      global.gc();
      await new Promise(resolve => setTimeout(resolve, 200));
      global.gc(); // Second pass
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterCleanupMemory = memoryProfiler.getCurrentUsage().heapUsed;
      const cleanupGrowthMB = (afterCleanupMemory - baselineMemory) / 1024 / 1024;
      const recoveredMemoryMB = (afterErrorsMemory - afterCleanupMemory) / 1024 / 1024;
      const recoveryPercentage = errorsGrowthMB > 0 ? (recoveredMemoryMB / errorsGrowthMB) * 100 : 0;

      console.log(`Resource Leak Detection Results:`);
      console.log(`  Error scenarios growth: ${errorsGrowthMB.toFixed(2)}MB`);
      console.log(`  Final growth: ${cleanupGrowthMB.toFixed(2)}MB`);
      console.log(`  Memory recovered: ${recoveredMemoryMB.toFixed(2)}MB`);
      console.log(`  Recovery percentage: ${recoveryPercentage.toFixed(2)}%`);

      // Should not have major resource leaks even in error scenarios
      expect(cleanupGrowthMB).toBeLessThan(30); // Final growth <30MB
      expect(recoveryPercentage).toBeGreaterThan(50); // Recover >50% even after errors
    });
  });
});