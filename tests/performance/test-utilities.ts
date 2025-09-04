import { PRInfo, PRDiff } from '../../src/pr-analyzer';

export interface LargePRConfig {
  filesCount: number;
  linesPerFile: number;
  totalAdditions?: number;
  totalDeletions?: number;
}

export interface LargePRFixture {
  prInfo: any;
  files: any[];
}

/**
 * Performance timing utility
 */
export class PerformanceTimer {
  private startTimes: Map<symbol, bigint> = new Map();

  start(): symbol {
    const id = Symbol('timer');
    this.startTimes.set(id, process.hrtime.bigint());
    return id;
  }

  end(id: symbol): number {
    const startTime = this.startTimes.get(id);
    if (!startTime) {
      throw new Error('Timer not found');
    }
    
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1000000; // Convert to milliseconds
    this.startTimes.delete(id);
    return duration;
  }

  measure<T>(operation: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const id = this.start();
    return operation().then(result => ({
      result,
      duration: this.end(id),
    }));
  }

  measureSync<T>(operation: () => T): { result: T; duration: number } {
    const id = this.start();
    const result = operation();
    const duration = this.end(id);
    return { result, duration };
  }
}

/**
 * Memory profiling utility
 */
export class MemoryProfiler {
  private snapshots: NodeJS.MemoryUsage[] = [];

  getCurrentUsage(): NodeJS.MemoryUsage {
    return process.memoryUsage();
  }

  takeSnapshot(label?: string): NodeJS.MemoryUsage {
    const snapshot = this.getCurrentUsage();
    this.snapshots.push(snapshot);
    
    if (label) {
      console.log(`Memory Snapshot [${label}]:`);
      console.log(`  Heap Used: ${(snapshot.heapUsed / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  Heap Total: ${(snapshot.heapTotal / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  RSS: ${(snapshot.rss / 1024 / 1024).toFixed(2)}MB`);
      console.log(`  External: ${(snapshot.external / 1024 / 1024).toFixed(2)}MB`);
    }
    
    return snapshot;
  }

  getMemoryGrowth(): number {
    if (this.snapshots.length < 2) {
      return 0;
    }
    
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    return last.heapUsed - first.heapUsed;
  }

  reset(): void {
    this.snapshots = [];
  }

  async trackMemoryDuringOperation<T>(operation: () => Promise<T>): Promise<{ result: T; memoryGrowth: number; peakMemory: number }> {
    const initialMemory = this.getCurrentUsage().heapUsed;
    let peakMemory = initialMemory;
    
    // Monitor memory during operation
    const memoryMonitor = setInterval(() => {
      const current = this.getCurrentUsage().heapUsed;
      if (current > peakMemory) {
        peakMemory = current;
      }
    }, 100); // Check every 100ms

    try {
      const result = await operation();
      clearInterval(memoryMonitor);
      
      const finalMemory = this.getCurrentUsage().heapUsed;
      const memoryGrowth = finalMemory - initialMemory;
      
      return {
        result,
        memoryGrowth,
        peakMemory,
      };
    } catch (error) {
      clearInterval(memoryMonitor);
      throw error;
    }
  }
}

/**
 * Generate large PR fixtures for performance testing
 */
export function createLargePRFixture(config: LargePRConfig): LargePRFixture {
  const { filesCount, linesPerFile, totalAdditions = 0, totalDeletions = 0 } = config;
  
  // Generate files with realistic content
  const files = [];
  const fileTypes = ['.ts', '.js', '.py', '.java', '.go', '.rb', '.php', '.cpp'];
  const directories = ['src', 'lib', 'test', 'docs', 'config', 'scripts', 'components', 'utils'];

  for (let i = 0; i < filesCount; i++) {
    const fileType = fileTypes[i % fileTypes.length];
    const directory = directories[i % directories.length];
    const filename = `${directory}/module-${Math.floor(i / 10)}/file-${i}${fileType}`;
    
    // Generate realistic patch content
    const additions = Math.floor(linesPerFile * (0.7 + Math.random() * 0.6)); // 70-130% of base
    const deletions = Math.floor(additions * (0.2 + Math.random() * 0.3)); // 20-50% of additions
    
    const patch = generatePatchContent(filename, additions, deletions);
    
    files.push({
      sha: `${i.toString().padStart(7, '0')}abcdef`,
      filename,
      status: i % 10 === 0 ? 'added' : i % 15 === 0 ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      patch,
      blob_url: `https://github.com/test-owner/test-repo/blob/abc123/${filename}`,
      raw_url: `https://github.com/test-owner/test-repo/raw/abc123/${filename}`,
      contents_url: `https://api.github.com/repos/test-owner/test-repo/contents/${filename}`,
    });
  }

  const calculatedAdditions = totalAdditions || files.reduce((sum, f) => sum + f.additions, 0);
  const calculatedDeletions = totalDeletions || files.reduce((sum, f) => sum + f.deletions, 0);

  const prInfo = {
    id: 123456789,
    number: 123,
    state: 'open',
    title: `Large PR with ${filesCount} files and ${calculatedAdditions + calculatedDeletions} line changes`,
    body: `This is a large pull request created for performance testing.\n\n## Changes\n\n- Modified ${filesCount} files\n- Added ${calculatedAdditions} lines\n- Removed ${calculatedDeletions} lines\n\n## Testing\n\nPerformance test fixture with realistic file structure and content.`,
    user: {
      login: 'test-user',
      id: 12345,
      avatar_url: 'https://github.com/images/error/test-user_happy.gif',
      url: 'https://api.github.com/users/test-user',
    },
    head: {
      label: 'test-owner:feature-large-pr',
      ref: 'feature-large-pr',
      sha: 'abc123def456ghi789',
      repo: {
        name: 'test-repo',
        full_name: 'test-owner/test-repo',
      },
    },
    base: {
      label: 'test-owner:main',
      ref: 'main', 
      sha: 'def456ghi789abc123',
      repo: {
        name: 'test-repo',
        full_name: 'test-owner/test-repo',
      },
    },
    draft: false,
    merged: false,
    mergeable: true,
    merged_by: null,
    comments: Math.floor(Math.random() * 10),
    review_comments: Math.floor(Math.random() * 20),
    commits: Math.floor(filesCount / 5) + 1,
    additions: calculatedAdditions,
    deletions: calculatedDeletions,
    changed_files: filesCount,
    created_at: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(), // Within last week
    updated_at: new Date(Date.now() - Math.random() * 24 * 60 * 60 * 1000).toISOString(), // Within last day
    url: 'https://api.github.com/repos/test-owner/test-repo/pulls/123',
    html_url: 'https://github.com/test-owner/test-repo/pull/123',
  };

  return { prInfo, files };
}

/**
 * Generate realistic patch content for a file
 */
function generatePatchContent(filename: string, additions: number, deletions: number): string {
  const fileExtension = filename.split('.').pop();
  const lines = [];
  
  // Add patch header
  lines.push(`diff --git a/${filename} b/${filename}`);
  lines.push(`index 1234567..abcdefg 100644`);
  lines.push(`--- a/${filename}`);
  lines.push(`+++ b/${filename}`);
  lines.push(`@@ -1,${deletions} +1,${additions} @@`);

  // Generate content based on file type
  const contentGenerator = getContentGenerator(fileExtension || 'txt');
  
  // Add some unchanged context lines
  for (let i = 0; i < 3; i++) {
    lines.push(` ${contentGenerator.unchangedLine(i)}`);
  }
  
  // Add deletions
  for (let i = 0; i < deletions; i++) {
    lines.push(`-${contentGenerator.deletedLine(i)}`);
  }
  
  // Add additions
  for (let i = 0; i < additions; i++) {
    lines.push(`+${contentGenerator.addedLine(i)}`);
  }
  
  // Add more context
  for (let i = 0; i < 3; i++) {
    lines.push(` ${contentGenerator.unchangedLine(i + 100)}`);
  }

  return lines.join('\n');
}

/**
 * Content generators for different file types
 */
function getContentGenerator(extension: string) {
  const generators: Record<string, any> = {
    ts: {
      unchangedLine: (i: number) => `    // Existing TypeScript code line ${i}`,
      deletedLine: (i: number) => `    const oldVariable${i} = 'deprecated';`,
      addedLine: (i: number) => `    const newVariable${i}: string = 'improved implementation';`,
    },
    js: {
      unchangedLine: (i: number) => `    // Existing JavaScript code line ${i}`,
      deletedLine: (i: number) => `    var oldVar${i} = 'legacy';`,
      addedLine: (i: number) => `    const newConst${i} = 'modern ES6';`,
    },
    py: {
      unchangedLine: (i: number) => `    # Existing Python code line ${i}`,
      deletedLine: (i: number) => `    old_variable_${i} = "deprecated"`,
      addedLine: (i: number) => `    new_variable_${i}: str = "improved implementation"`,
    },
    java: {
      unchangedLine: (i: number) => `        // Existing Java code line ${i}`,
      deletedLine: (i: number) => `        String oldString${i} = "deprecated";`,
      addedLine: (i: number) => `        final String newString${i} = "improved implementation";`,
    },
    go: {
      unchangedLine: (i: number) => `    // Existing Go code line ${i}`,
      deletedLine: (i: number) => `    oldVar${i} := "deprecated"`,
      addedLine: (i: number) => `    newVar${i} := "improved implementation"`,
    },
    default: {
      unchangedLine: (i: number) => `    // Existing code line ${i}`,
      deletedLine: (i: number) => `    old_line_${i}`,
      addedLine: (i: number) => `    new_line_${i}`,
    },
  };

  return generators[extension] || generators.default;
}

/**
 * Create a mock Octokit instance for testing
 */
export function createMockOctokit() {
  return {
    rest: {
      pulls: {
        get: jest.fn(),
        listFiles: jest.fn(),
      },
      issues: {
        listComments: jest.fn().mockResolvedValue({ data: [] }),
        createComment: jest.fn().mockResolvedValue({
          data: {
            id: Math.floor(Math.random() * 1000000),
            body: 'Mock comment',
            user: { login: 'visor-bot' },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
        updateComment: jest.fn().mockResolvedValue({
          data: {
            id: Math.floor(Math.random() * 1000000),
            body: 'Updated mock comment',
            user: { login: 'visor-bot' },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
        getComment: jest.fn().mockResolvedValue({
          data: {
            id: Math.floor(Math.random() * 1000000),
            body: 'Mock comment',
            user: { login: 'visor-bot' },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        }),
      },
      repos: {
        get: jest.fn().mockResolvedValue({
          data: {
            id: 123456,
            name: 'test-repo',
            full_name: 'test-owner/test-repo',
            description: 'Test repository for performance testing',
            stargazers_count: 42,
          },
        }),
      },
    },
  };
}

/**
 * Statistical utilities for performance analysis
 */
export class StatisticsCalculator {
  static mean(values: number[]): number {
    return values.reduce((sum, val) => sum + val, 0) / values.length;
  }

  static median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  static standardDeviation(values: number[]): number {
    const mean = this.mean(values);
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  static percentile(values: number[], percentile: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * percentile / 100) - 1;
    return sorted[Math.max(0, index)];
  }

  static summarize(values: number[]): {
    mean: number;
    median: number;
    min: number;
    max: number;
    stdDev: number;
    p95: number;
    p99: number;
  } {
    return {
      mean: this.mean(values),
      median: this.median(values),
      min: Math.min(...values),
      max: Math.max(...values),
      stdDev: this.standardDeviation(values),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99),
    };
  }
}

/**
 * Performance assertion helpers
 */
export class PerformanceAssertions {
  static expectPerformance(
    actualMs: number, 
    expectedMs: number, 
    tolerance: number = 0.2
  ): void {
    const maxAllowed = expectedMs * (1 + tolerance);
    if (actualMs > maxAllowed) {
      throw new Error(
        `Performance regression detected: ${actualMs.toFixed(2)}ms exceeds ${expectedMs}ms by more than ${tolerance * 100}% tolerance (max allowed: ${maxAllowed.toFixed(2)}ms)`
      );
    }
  }

  static expectMemoryUsage(
    actualMB: number,
    expectedMB: number,
    tolerance: number = 0.3
  ): void {
    const maxAllowed = expectedMB * (1 + tolerance);
    if (actualMB > maxAllowed) {
      throw new Error(
        `Memory usage regression detected: ${actualMB.toFixed(2)}MB exceeds ${expectedMB}MB by more than ${tolerance * 100}% tolerance (max allowed: ${maxAllowed.toFixed(2)}MB)`
      );
    }
  }
}

/**
 * Load testing utilities
 */
export class LoadTester {
  static async runConcurrentOperations<T>(
    operationFactory: () => Promise<T>,
    concurrency: number,
    iterations: number
  ): Promise<T[]> {
    const results: T[] = [];
    const batches = Math.ceil(iterations / concurrency);

    for (let batch = 0; batch < batches; batch++) {
      const batchSize = Math.min(concurrency, iterations - batch * concurrency);
      const promises = Array(batchSize).fill(0).map(() => operationFactory());
      
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }

    return results;
  }

  static async measureConcurrentOperations<T>(
    operationFactory: () => Promise<T>,
    concurrency: number,
    iterations: number,
    timer: PerformanceTimer
  ): Promise<{
    results: T[];
    totalDuration: number;
    avgDuration: number;
    operationsPerSecond: number;
  }> {
    const startTime = timer.start();
    
    const results = await this.runConcurrentOperations(
      operationFactory,
      concurrency,
      iterations
    );
    
    const totalDuration = timer.end(startTime);
    const avgDuration = totalDuration / iterations;
    const operationsPerSecond = (iterations * 1000) / totalDuration;

    return {
      results,
      totalDuration,
      avgDuration,
      operationsPerSecond,
    };
  }
}