#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PerformanceTimer, MemoryProfiler, StatisticsCalculator } from '../tests/performance/test-utilities';

export interface PerformanceBenchmark {
  name: string;
  category: string;
  timestamp: string;
  duration: number;
  memoryUsage: number;
  metadata: Record<string, any>;
}

export interface PerformanceReport {
  testRun: {
    timestamp: string;
    environment: {
      nodeVersion: string;
      platform: string;
      arch: string;
      cpus: number;
      totalMemory: number;
    };
    gitCommit?: string;
    branch?: string;
  };
  benchmarks: PerformanceBenchmark[];
  summary: {
    totalTests: number;
    totalDuration: number;
    averageDuration: number;
    memoryPeak: number;
    regressions: string[];
    improvements: string[];
  };
}

/**
 * Performance monitoring and regression detection tool
 */
export class PerformanceMonitor {
  private results: PerformanceBenchmark[] = [];
  private timer: PerformanceTimer;
  private memoryProfiler: MemoryProfiler;
  private baselineData: Map<string, PerformanceBenchmark> = new Map();
  private reportPath: string;

  constructor(reportPath?: string) {
    this.timer = new PerformanceTimer();
    this.memoryProfiler = new MemoryProfiler();
    this.reportPath = reportPath || path.join(process.cwd(), 'performance-reports');
    
    // Create reports directory if it doesn't exist
    if (!fs.existsSync(this.reportPath)) {
      fs.mkdirSync(this.reportPath, { recursive: true });
    }

    // Load baseline data
    this.loadBaseline();
  }

  /**
   * Start measuring a performance benchmark
   */
  startBenchmark(name: string, category: string = 'general', metadata: Record<string, any> = {}): symbol {
    const id = Symbol(`benchmark-${name}`);
    const startTime = this.timer.start();
    
    // Store benchmark context
    (startTime as any).__benchmarkContext = {
      name,
      category,
      metadata,
      startMemory: this.memoryProfiler.getCurrentUsage().heapUsed,
    };
    
    return id;
  }

  /**
   * End measuring a performance benchmark
   */
  endBenchmark(id: symbol): PerformanceBenchmark {
    const duration = this.timer.end(id);
    const context = (id as any).__benchmarkContext;
    const endMemory = this.memoryProfiler.getCurrentUsage().heapUsed;
    const memoryUsage = endMemory - (context?.startMemory || endMemory);
    
    const benchmark: PerformanceBenchmark = {
      name: context?.name || 'unnamed',
      category: context?.category || 'general',
      timestamp: new Date().toISOString(),
      duration,
      memoryUsage: memoryUsage / 1024 / 1024, // Convert to MB
      metadata: context?.metadata || {},
    };

    this.results.push(benchmark);
    return benchmark;
  }

  /**
   * Measure a synchronous operation
   */
  measureSync<T>(
    name: string,
    operation: () => T,
    category: string = 'general',
    metadata: Record<string, any> = {}
  ): { result: T; benchmark: PerformanceBenchmark } {
    const id = this.startBenchmark(name, category, metadata);
    const result = operation();
    const benchmark = this.endBenchmark(id);
    
    return { result, benchmark };
  }

  /**
   * Measure an asynchronous operation
   */
  async measureAsync<T>(
    name: string,
    operation: () => Promise<T>,
    category: string = 'general',
    metadata: Record<string, any> = {}
  ): Promise<{ result: T; benchmark: PerformanceBenchmark }> {
    const id = this.startBenchmark(name, category, metadata);
    const result = await operation();
    const benchmark = this.endBenchmark(id);
    
    return { result, benchmark };
  }

  /**
   * Run a performance test multiple times and collect statistics
   */
  async runRepeatedTest<T>(
    name: string,
    operation: () => Promise<T> | T,
    iterations: number = 10,
    category: string = 'repeated',
    metadata: Record<string, any> = {}
  ): Promise<{
    results: T[];
    statistics: {
      mean: number;
      median: number;
      min: number;
      max: number;
      stdDev: number;
      p95: number;
      p99: number;
    };
    benchmarks: PerformanceBenchmark[];
  }> {
    console.log(`🔄 Running repeated test "${name}" ${iterations} times...`);
    
    const results: T[] = [];
    const benchmarks: PerformanceBenchmark[] = [];
    const durations: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const id = this.startBenchmark(`${name}-${i}`, category, { 
        ...metadata, 
        iteration: i, 
        totalIterations: iterations 
      });
      
      try {
        const result = await Promise.resolve(operation());
        results.push(result);
      } catch (error) {
        console.warn(`Iteration ${i} failed:`, error);
      }
      
      const benchmark = this.endBenchmark(id);
      benchmarks.push(benchmark);
      durations.push(benchmark.duration);
      
      if (i % Math.max(1, Math.floor(iterations / 10)) === 0) {
        console.log(`  Progress: ${i + 1}/${iterations} (${benchmark.duration.toFixed(2)}ms)`);
      }
    }

    const statistics = StatisticsCalculator.summarize(durations);
    
    console.log(`✅ Repeated test "${name}" completed:`);
    console.log(`  Mean: ${statistics.mean.toFixed(2)}ms`);
    console.log(`  P95: ${statistics.p95.toFixed(2)}ms`);
    console.log(`  Range: ${statistics.min.toFixed(2)} - ${statistics.max.toFixed(2)}ms`);

    return { results, statistics, benchmarks };
  }

  /**
   * Check for performance regressions against baseline
   */
  checkRegressions(threshold: number = 0.2): {
    regressions: Array<{
      name: string;
      current: number;
      baseline: number;
      regression: number;
    }>;
    improvements: Array<{
      name: string;
      current: number;
      baseline: number;
      improvement: number;
    }>;
  } {
    const regressions: Array<{
      name: string;
      current: number;
      baseline: number;
      regression: number;
    }> = [];
    
    const improvements: Array<{
      name: string;
      current: number;
      baseline: number;
      improvement: number;
    }> = [];

    // Group current results by name
    const currentResults = this.results.reduce((groups, benchmark) => {
      if (!groups[benchmark.name]) groups[benchmark.name] = [];
      groups[benchmark.name].push(benchmark.duration);
      return groups;
    }, {} as Record<string, number[]>);

    // Compare with baseline
    for (const [name, durations] of Object.entries(currentResults)) {
      const baseline = this.baselineData.get(name);
      if (!baseline) continue;

      const currentAvg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
      const baselineAvg = baseline.duration;
      const change = (currentAvg - baselineAvg) / baselineAvg;

      if (change > threshold) {
        regressions.push({
          name,
          current: currentAvg,
          baseline: baselineAvg,
          regression: change,
        });
      } else if (change < -threshold) {
        improvements.push({
          name,
          current: currentAvg,
          baseline: baselineAvg,
          improvement: Math.abs(change),
        });
      }
    }

    return { regressions, improvements };
  }

  /**
   * Generate a comprehensive performance report
   */
  generateReport(): PerformanceReport {
    const { regressions, improvements } = this.checkRegressions();
    
    const totalDuration = this.results.reduce((sum, b) => sum + b.duration, 0);
    const averageDuration = totalDuration / this.results.length;
    const memoryPeak = Math.max(...this.results.map(b => b.memoryUsage));

    const report: PerformanceReport = {
      testRun: {
        timestamp: new Date().toISOString(),
        environment: {
          nodeVersion: process.version,
          platform: os.platform(),
          arch: os.arch(),
          cpus: os.cpus().length,
          totalMemory: os.totalmem() / 1024 / 1024 / 1024, // GB
        },
        gitCommit: this.getGitCommit(),
        branch: this.getGitBranch(),
      },
      benchmarks: [...this.results],
      summary: {
        totalTests: this.results.length,
        totalDuration,
        averageDuration,
        memoryPeak,
        regressions: regressions.map(r => `${r.name}: ${(r.regression * 100).toFixed(1)}% slower`),
        improvements: improvements.map(i => `${i.name}: ${(i.improvement * 100).toFixed(1)}% faster`),
      },
    };

    return report;
  }

  /**
   * Save performance report to file
   */
  saveReport(report?: PerformanceReport): string {
    const finalReport = report || this.generateReport();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const reportFile = path.join(this.reportPath, `performance-report-${timestamp}.json`);
    
    fs.writeFileSync(reportFile, JSON.stringify(finalReport, null, 2));
    
    console.log(`📊 Performance report saved: ${reportFile}`);
    return reportFile;
  }

  /**
   * Save current results as new baseline
   */
  saveBaseline(): void {
    // Calculate averages for each benchmark name
    const benchmarkAverages = this.results.reduce((acc, benchmark) => {
      if (!acc[benchmark.name]) {
        acc[benchmark.name] = { durations: [], memoryUsages: [], metadata: benchmark.metadata };
      }
      acc[benchmark.name].durations.push(benchmark.duration);
      acc[benchmark.name].memoryUsages.push(benchmark.memoryUsage);
      return acc;
    }, {} as Record<string, { durations: number[]; memoryUsages: number[]; metadata: any }>);

    // Create baseline entries
    const baseline: Record<string, PerformanceBenchmark> = {};
    for (const [name, data] of Object.entries(benchmarkAverages)) {
      const avgDuration = data.durations.reduce((sum, d) => sum + d, 0) / data.durations.length;
      const avgMemory = data.memoryUsages.reduce((sum, m) => sum + m, 0) / data.memoryUsages.length;
      
      baseline[name] = {
        name,
        category: 'baseline',
        timestamp: new Date().toISOString(),
        duration: avgDuration,
        memoryUsage: avgMemory,
        metadata: { ...data.metadata, samplesCount: data.durations.length },
      };
    }

    const baselineFile = path.join(this.reportPath, 'baseline.json');
    fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2));
    
    console.log(`📈 Performance baseline saved: ${baselineFile}`);
  }

  /**
   * Load baseline data from file
   */
  private loadBaseline(): void {
    const baselineFile = path.join(this.reportPath, 'baseline.json');
    
    if (fs.existsSync(baselineFile)) {
      try {
        const baselineData = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
        this.baselineData.clear();
        
        for (const [name, benchmark] of Object.entries(baselineData)) {
          this.baselineData.set(name, benchmark as PerformanceBenchmark);
        }
        
        console.log(`📊 Loaded baseline data for ${this.baselineData.size} benchmarks`);
      } catch (error) {
        console.warn('Could not load baseline data:', error);
      }
    }
  }

  /**
   * Get current Git commit hash
   */
  private getGitCommit(): string | undefined {
    try {
      const { execSync } = require('child_process');
      return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Get current Git branch
   */
  private getGitBranch(): string | undefined {
    try {
      const { execSync } = require('child_process');
      return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Clear all results
   */
  clear(): void {
    this.results = [];
  }

  /**
   * Get current results
   */
  getResults(): PerformanceBenchmark[] {
    return [...this.results];
  }

  /**
   * Print summary to console
   */
  printSummary(): void {
    if (this.results.length === 0) {
      console.log('📊 No performance results to display');
      return;
    }

    const { regressions, improvements } = this.checkRegressions();
    
    console.log('📊 Performance Summary');
    console.log('='.repeat(50));
    console.log(`Total benchmarks: ${this.results.length}`);
    console.log(`Total duration: ${this.results.reduce((sum, b) => sum + b.duration, 0).toFixed(2)}ms`);
    console.log(`Average duration: ${(this.results.reduce((sum, b) => sum + b.duration, 0) / this.results.length).toFixed(2)}ms`);
    console.log(`Peak memory: ${Math.max(...this.results.map(b => b.memoryUsage)).toFixed(2)}MB`);
    
    if (regressions.length > 0) {
      console.log('\n🔴 Regressions detected:');
      regressions.forEach(r => 
        console.log(`  ${r.name}: ${r.current.toFixed(2)}ms vs ${r.baseline.toFixed(2)}ms baseline (+${(r.regression * 100).toFixed(1)}%)`)
      );
    }
    
    if (improvements.length > 0) {
      console.log('\n🟢 Performance improvements:');
      improvements.forEach(i => 
        console.log(`  ${i.name}: ${i.current.toFixed(2)}ms vs ${i.baseline.toFixed(2)}ms baseline (-${(i.improvement * 100).toFixed(1)}%)`)
      );
    }
    
    if (regressions.length === 0 && improvements.length === 0) {
      console.log('\n✅ No significant performance changes detected');
    }
    
    console.log('='.repeat(50));
  }
}

/**
 * CLI tool for performance monitoring
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const monitor = new PerformanceMonitor();

  switch (command) {
    case 'run-benchmarks':
      await runBenchmarkSuite(monitor);
      break;
    
    case 'save-baseline':
      await runBenchmarkSuite(monitor);
      monitor.saveBaseline();
      break;
    
    case 'generate-report':
      const report = monitor.generateReport();
      const reportFile = monitor.saveReport(report);
      console.log(`Report generated: ${reportFile}`);
      break;
    
    case 'check-regressions':
      await runBenchmarkSuite(monitor);
      const { regressions, improvements } = monitor.checkRegressions();
      
      if (regressions.length > 0) {
        console.error('🔴 Performance regressions detected!');
        regressions.forEach(r => 
          console.error(`  ${r.name}: ${(r.regression * 100).toFixed(1)}% slower`)
        );
        process.exit(1);
      } else {
        console.log('✅ No performance regressions detected');
        if (improvements.length > 0) {
          console.log('🟢 Performance improvements found:');
          improvements.forEach(i => 
            console.log(`  ${i.name}: ${(i.improvement * 100).toFixed(1)}% faster`)
          );
        }
      }
      break;
    
    default:
      console.log('Usage: performance-monitor <command>');
      console.log('Commands:');
      console.log('  run-benchmarks    - Run the benchmark suite');
      console.log('  save-baseline     - Run benchmarks and save as baseline');
      console.log('  generate-report   - Generate performance report');
      console.log('  check-regressions - Check for performance regressions');
      break;
  }
}

/**
 * Run the benchmark suite
 */
async function runBenchmarkSuite(monitor: PerformanceMonitor): Promise<void> {
  console.log('🚀 Running Visor performance benchmark suite...');

  // Import required modules
  const { CLI } = await import('../src/cli');
  const { ConfigManager } = await import('../src/config');
  const { PRAnalyzer } = await import('../src/pr-analyzer');
  const { PRReviewer } = await import('../src/reviewer');
  const { ActionCliBridge } = await import('../src/action-cli-bridge');
  const { EventMapper } = await import('../src/event-mapper');
  const { createLargePRFixture, createMockOctokit } = await import('../tests/performance/test-utilities');

  const cli = new CLI();
  const configManager = new ConfigManager();
  const mockOctokit = createMockOctokit();

  // CLI Performance Benchmarks
  await monitor.measureAsync(
    'cli-startup-cold',
    async () => {
      const newCli = new CLI();
      const options = newCli.parseArgs(['--check', 'performance', '--output', 'json']);
      return options;
    },
    'cli',
    { type: 'cold-start', checks: 1 }
  );

  await monitor.runRepeatedTest(
    'cli-parsing-performance',
    () => {
      return cli.parseArgs(['--check', 'all', '--output', 'markdown', '--config', './config.yaml']);
    },
    20,
    'cli'
  );

  // Configuration Benchmarks
  await monitor.runRepeatedTest(
    'config-loading-performance',
    async () => {
      try {
        return await configManager.findAndLoadConfig();
      } catch (error) {
        return null; // Expected for missing config
      }
    },
    10,
    'config'
  );

  // PR Analysis Benchmarks
  const largePR = createLargePRFixture({ filesCount: 50, linesPerFile: 20 });
  mockOctokit.rest.pulls.get.mockResolvedValue({ data: largePR.prInfo });
  mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: largePR.files });

  const analyzer = new PRAnalyzer(mockOctokit);
  const reviewer = new PRReviewer(mockOctokit);

  await monitor.runRepeatedTest(
    'pr-analysis-large-pr',
    async () => {
      return await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);
    },
    10,
    'pr-analysis',
    { prSize: 'large', files: 50, linesPerFile: 20 }
  );

  await monitor.runRepeatedTest(
    'pr-review-large-pr',
    async () => {
      const prInfo = await analyzer.fetchPRDiff('test-owner', 'test-repo', 123);
      return await reviewer.reviewPR('test-owner', 'test-repo', 123, prInfo);
    },
    5,
    'pr-review',
    { prSize: 'large', files: 50, linesPerFile: 20 }
  );

  // Event Mapping Benchmarks
  const complexConfig = {
    version: '1.0',
    checks: {} as any,
    output: { pr_comment: { format: 'summary' as const, group_by: 'check' as const, collapse: true } },
  };

  // Add complex checks
  for (let i = 0; i < 20; i++) {
    complexConfig.checks[`complex-check-${i}`] = {
      type: 'ai' as const,
      prompt: `Complex check ${i}`,
      on: ['pr_opened' as const, 'pr_updated' as const],
      triggers: [`**/*.{js,ts}`, `src/module-${i}/**/*`],
    };
  }

  const eventMapper = new EventMapper(complexConfig);

  await monitor.runRepeatedTest(
    'event-mapping-complex-config',
    () => {
      const event = {
        event_name: 'pull_request',
        action: 'opened',
        repository: { owner: { login: 'test' }, name: 'repo' },
        pull_request: { number: 1, state: 'open', head: { sha: 'abc', ref: 'feature' }, base: { sha: 'def', ref: 'main' }, draft: false },
      };
      
      return eventMapper.mapEventToExecution(event, {
        changedFiles: ['src/test.js', 'src/module-1/test.ts'],
        modifiedFiles: ['src/test.js'],
      });
    },
    15,
    'event-mapping',
    { checksCount: 20, triggersPerCheck: 2 }
  );

  // ActionCliBridge Benchmarks
  const context = {
    event_name: 'pull_request',
    repository: { owner: { login: 'test' }, name: 'repo' },
  };

  const bridge = new ActionCliBridge('test-token', context);

  await monitor.runRepeatedTest(
    'action-cli-bridge-parsing',
    () => {
      const inputs = {
        'github-token': 'test-token',
        'visor-checks': 'security,performance,architecture,style',
        owner: 'test-owner',
        repo: 'test-repo',
      };
      
      return bridge.parseGitHubInputsToCliArgs(inputs);
    },
    25,
    'action-bridge'
  );

  monitor.printSummary();
  monitor.saveReport();
}

// Run CLI if called directly
if (require.main === module) {
  main().catch(error => {
    console.error('Performance monitor error:', error);
    process.exit(1);
  });
}