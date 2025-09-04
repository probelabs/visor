/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
/**
 * Race condition simulation utilities for testing concurrent operations
 */

export interface RaceConditionTest {
  name: string;
  setup: () => Promise<any>;
  operations: Array<() => Promise<any>>;
  validation: (results: any[]) => Promise<boolean>;
  cleanup?: () => Promise<void>;
}

export interface ConcurrencyTestResult {
  testName: string;
  totalOperations: number;
  successful: number;
  failed: number;
  raceConditionsDetected: number;
  duration: number;
  passed: boolean;
}

/**
 * Race condition simulator for testing concurrent operations
 */
export class RaceConditionSimulator {
  private results: Map<string, ConcurrencyTestResult> = new Map();

  /**
   * Run a race condition test with controlled timing
   */
  async runTest(test: RaceConditionTest): Promise<ConcurrencyTestResult> {
    console.log(`🏃 Running race condition test: ${test.name}`);

    const startTime = Date.now();

    // Setup phase
    let context: any;
    try {
      context = await test.setup();
    } catch (error) {
      console.error(`Setup failed for ${test.name}:`, error);
      throw error;
    }

    // Execute operations concurrently with slight timing variations
    const operationPromises = test.operations.map(
      (operation, index) => this.executeWithRandomDelay(operation, index * 5, 50) // Stagger by 5ms + random up to 50ms
    );

    const results = await Promise.allSettled(operationPromises);

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;

    // Validation phase
    const validationResults = results
      .filter(r => r.status === 'fulfilled')
      .map(r => (r as PromiseFulfilledResult<any>).value);

    let passed = false;
    let raceConditionsDetected = 0;

    try {
      passed = await test.validation(validationResults);

      // Additional race condition detection
      raceConditionsDetected = this.detectRaceConditions(validationResults);
    } catch (error) {
      console.error(`Validation failed for ${test.name}:`, error);
      passed = false;
    }

    // Cleanup phase
    if (test.cleanup) {
      try {
        await test.cleanup();
      } catch (error) {
        console.warn(`Cleanup warning for ${test.name}:`, error);
      }
    }

    const duration = Date.now() - startTime;

    const result: ConcurrencyTestResult = {
      testName: test.name,
      totalOperations: test.operations.length,
      successful,
      failed,
      raceConditionsDetected,
      duration,
      passed,
    };

    this.results.set(test.name, result);

    console.log(`✅ Completed ${test.name}:`);
    console.log(`   Success: ${successful}/${test.operations.length}`);
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Race conditions: ${raceConditionsDetected}`);
    console.log(`   Passed: ${passed}`);

    return result;
  }

  /**
   * Execute operation with random delay to create race conditions
   */
  private async executeWithRandomDelay(
    operation: () => Promise<any>,
    baseDelay: number = 0,
    maxRandomDelay: number = 100
  ): Promise<any> {
    const delay = baseDelay + Math.random() * maxRandomDelay;
    await new Promise(resolve => setTimeout(resolve, delay));
    return operation();
  }

  /**
   * Detect potential race conditions in results
   */
  private detectRaceConditions(results: any[]): number {
    let detected = 0;

    // Look for common race condition indicators
    for (const result of results) {
      if (this.hasTimestampAnomalies(result)) detected++;
      if (this.hasStateInconsistencies(result)) detected++;
      if (this.hasSequenceViolations(result)) detected++;
    }

    return detected;
  }

  /**
   * Check for timestamp anomalies that might indicate race conditions
   */
  private hasTimestampAnomalies(result: any): boolean {
    if (!result || typeof result !== 'object') return false;

    // Look for timestamps that are out of order
    const timestamps = this.extractTimestamps(result);
    if (timestamps.length < 2) return false;

    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] < timestamps[i - 1]) {
        return true; // Timestamp went backwards
      }
    }

    return false;
  }

  /**
   * Check for state inconsistencies
   */
  private hasStateInconsistencies(result: any): boolean {
    if (!result || typeof result !== 'object') return false;

    // Look for common state inconsistency patterns
    if (result.state === 'completed' && !result.completedAt) return true;
    if (result.state === 'failed' && result.success === true) return true;
    if (result.count && result.items && result.count !== result.items.length) return true;

    return false;
  }

  /**
   * Check for sequence violations
   */
  private hasSequenceViolations(result: any): boolean {
    if (!result || typeof result !== 'object') return false;

    // Look for sequence number violations
    if (result.sequence && result.previousSequence) {
      return result.sequence <= result.previousSequence;
    }

    return false;
  }

  /**
   * Extract timestamps from result object
   */
  private extractTimestamps(obj: any): number[] {
    const timestamps: number[] = [];

    if (typeof obj !== 'object' || obj === null) return timestamps;

    const timestampKeys = ['timestamp', 'createdAt', 'updatedAt', 'processedAt', 'completedAt'];

    for (const key of timestampKeys) {
      if (obj[key]) {
        const ts = typeof obj[key] === 'string' ? Date.parse(obj[key]) : obj[key];
        if (!isNaN(ts)) timestamps.push(ts);
      }
    }

    return timestamps.sort((a, b) => a - b);
  }

  /**
   * Run multiple race condition tests
   */
  async runTestSuite(tests: RaceConditionTest[]): Promise<Map<string, ConcurrencyTestResult>> {
    console.log(`🎯 Running race condition test suite: ${tests.length} tests`);

    for (const test of tests) {
      try {
        await this.runTest(test);
      } catch (error) {
        console.error(`Test suite error in ${test.name}:`, error);

        // Record failed test
        this.results.set(test.name, {
          testName: test.name,
          totalOperations: test.operations.length,
          successful: 0,
          failed: test.operations.length,
          raceConditionsDetected: 0,
          duration: 0,
          passed: false,
        });
      }
    }

    return this.results;
  }

  /**
   * Get summary of all test results
   */
  getSummary(): {
    totalTests: number;
    passed: number;
    failed: number;
    totalRaceConditions: number;
    averageDuration: number;
  } {
    const results = Array.from(this.results.values());

    return {
      totalTests: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      totalRaceConditions: results.reduce((sum, r) => sum + r.raceConditionsDetected, 0),
      averageDuration: results.reduce((sum, r) => sum + r.duration, 0) / results.length,
    };
  }

  /**
   * Clear all test results
   */
  reset(): void {
    this.results.clear();
  }
}

/**
 * Utility functions for creating common race condition tests
 */
export class RaceConditionTestBuilder {
  /**
   * Create a test for concurrent counter increments
   */
  static createCounterTest(
    name: string,
    initialValue: number = 0,
    incrementCount: number = 10
  ): RaceConditionTest {
    let counter = initialValue;
    const expectedValue = initialValue + incrementCount;
    const results: number[] = [];

    return {
      name,
      setup: async () => {
        counter = initialValue;
        results.length = 0;
        return { counter, expectedValue };
      },
      operations: Array(incrementCount)
        .fill(0)
        .map((_, i) => async () => {
          const oldValue = counter;
          // Simulate some processing time
          await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
          counter++;
          results.push(counter);
          return { operationId: i, oldValue, newValue: counter };
        }),
      validation: async operationResults => {
        // Check if final counter value is correct
        const finalCounterCorrect = counter === expectedValue;

        // Check for duplicate values (indicates race condition)
        const uniqueResults = new Set(results);
        const noDuplicates = uniqueResults.size === results.length;

        return finalCounterCorrect && noDuplicates;
      },
    };
  }

  /**
   * Create a test for concurrent resource allocation
   */
  static createResourceAllocationTest(
    name: string,
    totalResources: number = 10,
    allocationRequests: number = 15
  ): RaceConditionTest {
    let availableResources = totalResources;
    const allocations: Array<{ id: number; allocated: boolean; timestamp: number }> = [];

    return {
      name,
      setup: async () => {
        availableResources = totalResources;
        allocations.length = 0;
        return { totalResources, allocationRequests };
      },
      operations: Array(allocationRequests)
        .fill(0)
        .map((_, i) => async () => {
          const timestamp = Date.now();
          await new Promise(resolve => setTimeout(resolve, Math.random() * 5));

          if (availableResources > 0) {
            availableResources--;
            const allocation = { id: i, allocated: true, timestamp };
            allocations.push(allocation);
            return allocation;
          } else {
            const allocation = { id: i, allocated: false, timestamp };
            allocations.push(allocation);
            return allocation;
          }
        }),
      validation: async () => {
        // Check that we didn't over-allocate
        const successfulAllocations = allocations.filter(a => a.allocated).length;
        const noOverAllocation = successfulAllocations <= totalResources;

        // Check that final resource count is consistent
        const finalResourcesCorrect =
          availableResources === Math.max(0, totalResources - successfulAllocations);

        return noOverAllocation && finalResourcesCorrect;
      },
    };
  }

  /**
   * Create a test for concurrent map modifications
   */
  static createMapModificationTest(name: string, operationCount: number = 20): RaceConditionTest {
    const sharedMap = new Map<string, any>();
    const operations: string[] = [];

    return {
      name,
      setup: async () => {
        sharedMap.clear();
        operations.length = 0;
        return { operationCount };
      },
      operations: Array(operationCount)
        .fill(0)
        .map((_, i) => async () => {
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3));

          const key = `key-${i % 5}`; // Use limited key set to create conflicts
          const operation = Math.random() < 0.7 ? 'set' : 'delete';

          if (operation === 'set') {
            const value = { id: i, timestamp: Date.now() };
            sharedMap.set(key, value);
            operations.push(`set:${key}:${i}`);
            return { operation: 'set', key, value, success: true };
          } else {
            const existed = sharedMap.has(key);
            sharedMap.delete(key);
            operations.push(`delete:${key}:${i}`);
            return { operation: 'delete', key, existed, success: true };
          }
        }),
      validation: async () => {
        // Check that map is in a consistent state
        const finalSize = sharedMap.size;
        const allKeysValid = Array.from(sharedMap.keys()).every(
          key => typeof key === 'string' && key.startsWith('key-')
        );

        // Check that operations array length matches expected
        const correctOperationCount = operations.length === operationCount;

        return allKeysValid && correctOperationCount;
      },
    };
  }
}
