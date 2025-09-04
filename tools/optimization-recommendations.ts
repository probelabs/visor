import * as fs from 'fs';
import * as path from 'path';
import { PerformanceBenchmark, PerformanceReport } from './performance-monitor';

export interface OptimizationRecommendation {
  category: 'performance' | 'memory' | 'scalability' | 'reliability';
  priority: 'high' | 'medium' | 'low';
  title: string;
  description: string;
  impact: string;
  implementation: string;
  estimatedEffort: 'low' | 'medium' | 'high';
  affectedComponents: string[];
  benchmarkEvidence?: string[];
}

export interface OptimizationReport {
  timestamp: string;
  performanceReport: PerformanceReport;
  recommendations: OptimizationRecommendation[];
  summary: {
    totalRecommendations: number;
    highPriority: number;
    estimatedImprovements: string[];
    quickWins: OptimizationRecommendation[];
  };
}

/**
 * Optimization recommendations engine based on performance analysis
 */
export class OptimizationRecommendationsEngine {
  
  /**
   * Generate optimization recommendations from performance report
   */
  generateRecommendations(report: PerformanceReport): OptimizationReport {
    const recommendations: OptimizationRecommendation[] = [];
    
    // Analyze benchmarks for optimization opportunities
    recommendations.push(...this.analyzeCLIPerformance(report));
    recommendations.push(...this.analyzeMemoryUsage(report));
    recommendations.push(...this.analyzePRAnalysisPerformance(report));
    recommendations.push(...this.analyzeEventMappingPerformance(report));
    recommendations.push(...this.analyzeScalabilityIssues(report));
    recommendations.push(...this.analyzeGeneralPerformancePatterns(report));
    
    // Sort by priority and impact
    recommendations.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    const highPriority = recommendations.filter(r => r.priority === 'high').length;
    const quickWins = recommendations.filter(r => 
      r.estimatedEffort === 'low' && (r.priority === 'high' || r.priority === 'medium')
    );

    const optimizationReport: OptimizationReport = {
      timestamp: new Date().toISOString(),
      performanceReport: report,
      recommendations,
      summary: {
        totalRecommendations: recommendations.length,
        highPriority,
        estimatedImprovements: this.calculateEstimatedImprovements(recommendations, report),
        quickWins,
      },
    };

    return optimizationReport;
  }

  /**
   * Analyze CLI performance benchmarks
   */
  private analyzeCLIPerformance(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];
    const cliBenchmarks = report.benchmarks.filter(b => b.category === 'cli');
    
    if (cliBenchmarks.length === 0) return recommendations;

    // Check CLI startup time
    const startupBenchmarks = cliBenchmarks.filter(b => b.name.includes('startup'));
    if (startupBenchmarks.length > 0) {
      const avgStartupTime = startupBenchmarks.reduce((sum, b) => sum + b.duration, 0) / startupBenchmarks.length;
      
      if (avgStartupTime > 1000) { // > 1 second
        recommendations.push({
          category: 'performance',
          priority: 'high',
          title: 'Optimize CLI Startup Time',
          description: `CLI startup time is ${avgStartupTime.toFixed(2)}ms, which exceeds the target of <1000ms.`,
          impact: 'Improves developer experience and CI/CD pipeline speed',
          implementation: `
            1. Implement lazy loading for heavy modules
            2. Use dynamic imports for optional dependencies
            3. Cache parsed configuration between runs
            4. Optimize argument parsing logic
          `,
          estimatedEffort: 'medium',
          affectedComponents: ['cli.ts', 'cli-main.ts', 'config.ts'],
          benchmarkEvidence: startupBenchmarks.map(b => `${b.name}: ${b.duration.toFixed(2)}ms`),
        });
      }
    }

    // Check parsing performance
    const parsingBenchmarks = cliBenchmarks.filter(b => b.name.includes('parsing'));
    if (parsingBenchmarks.length > 0) {
      const avgParsingTime = parsingBenchmarks.reduce((sum, b) => sum + b.duration, 0) / parsingBenchmarks.length;
      
      if (avgParsingTime > 50) { // > 50ms per parse
        recommendations.push({
          category: 'performance',
          priority: 'medium',
          title: 'Optimize CLI Argument Parsing',
          description: `CLI parsing takes ${avgParsingTime.toFixed(2)}ms on average, which could be improved.`,
          impact: 'Faster CLI operations, especially in automated environments',
          implementation: `
            1. Pre-compile argument validation rules
            2. Optimize regex patterns used in validation
            3. Implement argument parsing cache for repeated patterns
            4. Use more efficient data structures for option lookup
          `,
          estimatedEffort: 'low',
          affectedComponents: ['cli.ts'],
          benchmarkEvidence: parsingBenchmarks.map(b => `${b.name}: ${b.duration.toFixed(2)}ms`),
        });
      }
    }

    return recommendations;
  }

  /**
   * Analyze memory usage patterns
   */
  private analyzeMemoryUsage(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];
    const avgMemoryUsage = report.benchmarks.reduce((sum, b) => sum + b.memoryUsage, 0) / report.benchmarks.length;
    
    if (avgMemoryUsage > 100) { // > 100MB average
      recommendations.push({
        category: 'memory',
        priority: 'high',
        title: 'Reduce Memory Usage',
        description: `Average memory usage is ${avgMemoryUsage.toFixed(2)}MB, which is higher than optimal.`,
        impact: 'Better performance in resource-constrained environments, reduced memory pressure',
        implementation: `
          1. Implement object pooling for frequently created objects
          2. Use streaming processing for large PR data
          3. Implement memory-efficient data structures
          4. Add explicit cleanup for large objects
          5. Use WeakMap/WeakSet where appropriate
        `,
        estimatedEffort: 'high',
        affectedComponents: ['pr-analyzer.ts', 'reviewer.ts', 'event-mapper.ts'],
        benchmarkEvidence: [`Average memory usage: ${avgMemoryUsage.toFixed(2)}MB`],
      });
    }

    // Check for memory growth patterns
    const memoryGrowthBenchmarks = report.benchmarks
      .filter(b => b.name.includes('repeated') || b.name.includes('large'))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    
    if (memoryGrowthBenchmarks.length > 3) {
      const firstMemory = memoryGrowthBenchmarks[0].memoryUsage;
      const lastMemory = memoryGrowthBenchmarks[memoryGrowthBenchmarks.length - 1].memoryUsage;
      const growthRate = (lastMemory - firstMemory) / firstMemory;
      
      if (growthRate > 0.5) { // > 50% memory growth
        recommendations.push({
          category: 'memory',
          priority: 'high',
          title: 'Fix Memory Leak Pattern',
          description: `Memory usage grows ${(growthRate * 100).toFixed(1)}% during repeated operations, indicating potential memory leaks.`,
          impact: 'Prevents memory exhaustion in long-running processes',
          implementation: `
            1. Add memory profiling to identify leak sources
            2. Implement proper cleanup in error paths
            3. Use memory leak detection tools
            4. Add unit tests for memory cleanup
            5. Review event listener cleanup
          `,
          estimatedEffort: 'high',
          affectedComponents: ['All components'],
          benchmarkEvidence: [`Memory growth: ${(growthRate * 100).toFixed(1)}%`],
        });
      }
    }

    return recommendations;
  }

  /**
   * Analyze PR analysis performance
   */
  private analyzePRAnalysisPerformance(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];
    const prBenchmarks = report.benchmarks.filter(b => 
      b.category === 'pr-analysis' || b.category === 'pr-review'
    );
    
    if (prBenchmarks.length === 0) return recommendations;

    const avgAnalysisTime = prBenchmarks
      .filter(b => b.name.includes('analysis'))
      .reduce((sum, b, _, arr) => sum + b.duration / arr.length, 0);

    const avgReviewTime = prBenchmarks
      .filter(b => b.name.includes('review'))
      .reduce((sum, b, _, arr) => sum + b.duration / arr.length, 0);

    if (avgAnalysisTime > 5000) { // > 5 seconds
      recommendations.push({
        category: 'performance',
        priority: 'high',
        title: 'Optimize PR Analysis Performance',
        description: `PR analysis takes ${avgAnalysisTime.toFixed(2)}ms on average for large PRs, exceeding the 5-second target.`,
        impact: 'Faster PR processing, better user experience',
        implementation: `
          1. Implement parallel processing for file analysis
          2. Add caching for repeated file analysis
          3. Implement incremental analysis for updated PRs
          4. Use streaming for large file processing
          5. Optimize diff parsing algorithms
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['pr-analyzer.ts'],
        benchmarkEvidence: [`Average analysis time: ${avgAnalysisTime.toFixed(2)}ms`],
      });
    }

    if (avgReviewTime > 10000) { // > 10 seconds
      recommendations.push({
        category: 'performance',
        priority: 'high',
        title: 'Optimize AI Review Performance',
        description: `PR review takes ${avgReviewTime.toFixed(2)}ms on average, which is slower than the 10-second target.`,
        impact: 'Faster review cycles, improved CI/CD integration',
        implementation: `
          1. Implement AI response caching
          2. Optimize AI prompt construction
          3. Use parallel AI requests for independent checks
          4. Implement smart batching of review requests
          5. Add AI service connection pooling
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['reviewer.ts'],
        benchmarkEvidence: [`Average review time: ${avgReviewTime.toFixed(2)}ms`],
      });
    }

    return recommendations;
  }

  /**
   * Analyze event mapping performance
   */
  private analyzeEventMappingPerformance(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];
    const eventMappingBenchmarks = report.benchmarks.filter(b => b.category === 'event-mapping');
    
    if (eventMappingBenchmarks.length === 0) return recommendations;

    const avgMappingTime = eventMappingBenchmarks.reduce((sum, b) => sum + b.duration, 0) / eventMappingBenchmarks.length;
    
    if (avgMappingTime > 100) { // > 100ms
      recommendations.push({
        category: 'performance',
        priority: 'medium',
        title: 'Optimize Event Mapping Performance',
        description: `Event mapping takes ${avgMappingTime.toFixed(2)}ms on average, which could be improved for complex configurations.`,
        impact: 'Faster GitHub webhook processing, reduced latency',
        implementation: `
          1. Pre-compile trigger patterns at configuration load time
          2. Use more efficient pattern matching algorithms
          3. Implement configuration validation caching
          4. Optimize condition evaluation order
          5. Use lookup tables for common patterns
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['event-mapper.ts'],
        benchmarkEvidence: [`Average mapping time: ${avgMappingTime.toFixed(2)}ms`],
      });
    }

    // Check for complex configuration impact
    const complexMappingBenchmarks = eventMappingBenchmarks.filter(b => 
      b.metadata?.checksCount && b.metadata.checksCount > 10
    );
    
    if (complexMappingBenchmarks.length > 0) {
      const avgComplexTime = complexMappingBenchmarks.reduce((sum, b) => sum + b.duration, 0) / complexMappingBenchmarks.length;
      
      if (avgComplexTime > avgMappingTime * 1.5) {
        recommendations.push({
          category: 'scalability',
          priority: 'medium',
          title: 'Improve Configuration Scaling',
          description: `Event mapping performance degrades significantly with complex configurations (${avgComplexTime.toFixed(2)}ms vs ${avgMappingTime.toFixed(2)}ms average).`,
          impact: 'Better performance for users with many checks and complex triggers',
          implementation: `
            1. Implement check prioritization and early exit
            2. Use indexing for trigger pattern matching
            3. Add configuration complexity warnings
            4. Implement lazy evaluation of conditions
            5. Cache frequently used configuration subsets
          `,
          estimatedEffort: 'high',
          affectedComponents: ['event-mapper.ts', 'config.ts'],
          benchmarkEvidence: [`Complex config time: ${avgComplexTime.toFixed(2)}ms`],
        });
      }
    }

    return recommendations;
  }

  /**
   * Analyze scalability issues
   */
  private analyzeScalabilityIssues(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    // Check for O(n²) or worse scaling patterns
    const repeatedBenchmarks = report.benchmarks.filter(b => b.name.includes('repeated'));
    if (repeatedBenchmarks.length > 0) {
      // Group by base name and analyze scaling
      const benchmarkGroups = repeatedBenchmarks.reduce((groups, b) => {
        const baseName = b.name.split('-repeated')[0] || b.name;
        if (!groups[baseName]) groups[baseName] = [];
        groups[baseName].push(b);
        return groups;
      }, {} as Record<string, PerformanceBenchmark[]>);

      for (const [name, benchmarks] of Object.entries(benchmarkGroups)) {
        if (benchmarks.length < 3) continue;

        const sortedBenchmarks = benchmarks.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const firstDuration = sortedBenchmarks[0].duration;
        const lastDuration = sortedBenchmarks[sortedBenchmarks.length - 1].duration;
        const scalingFactor = lastDuration / firstDuration;

        if (scalingFactor > 2.0) { // Performance degrades more than 2x
          recommendations.push({
            category: 'scalability',
            priority: 'high',
            title: `Address Scaling Issues in ${name}`,
            description: `Performance degrades ${scalingFactor.toFixed(1)}x during repeated operations, indicating poor scaling characteristics.`,
            impact: 'Better performance under load, improved reliability',
            implementation: `
              1. Profile the operation to identify bottlenecks
              2. Implement caching for expensive operations
              3. Optimize data structures and algorithms
              4. Add early termination conditions
              5. Consider implementing batching
            `,
            estimatedEffort: 'high',
            affectedComponents: [name],
            benchmarkEvidence: [`Scaling factor: ${scalingFactor.toFixed(1)}x`],
          });
        }
      }
    }

    return recommendations;
  }

  /**
   * Analyze general performance patterns
   */
  private analyzeGeneralPerformancePatterns(report: PerformanceReport): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = [];

    // Check for slow operations in general
    const slowOperations = report.benchmarks.filter(b => b.duration > 1000); // > 1 second
    if (slowOperations.length > report.benchmarks.length * 0.2) { // > 20% are slow
      recommendations.push({
        category: 'performance',
        priority: 'medium',
        title: 'General Performance Optimization',
        description: `${slowOperations.length} out of ${report.benchmarks.length} operations (${((slowOperations.length / report.benchmarks.length) * 100).toFixed(1)}%) exceed 1 second.`,
        impact: 'Overall application responsiveness improvement',
        implementation: `
          1. Add performance monitoring to production
          2. Implement operation timeouts
          3. Add performance budgets to CI/CD
          4. Optimize most frequently used code paths
          5. Consider implementing progressive loading
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['All components'],
        benchmarkEvidence: [`Slow operations: ${slowOperations.length}/${report.benchmarks.length}`],
      });
    }

    // Check for memory efficiency issues
    const memoryHeavyOperations = report.benchmarks.filter(b => b.memoryUsage > 50); // > 50MB
    if (memoryHeavyOperations.length > 0) {
      const avgMemoryHeavy = memoryHeavyOperations.reduce((sum, b) => sum + b.memoryUsage, 0) / memoryHeavyOperations.length;
      
      recommendations.push({
        category: 'memory',
        priority: 'medium',
        title: 'Optimize Memory-Heavy Operations',
        description: `${memoryHeavyOperations.length} operations use significant memory (average: ${avgMemoryHeavy.toFixed(2)}MB).`,
        impact: 'Reduced memory footprint, better resource utilization',
        implementation: `
          1. Implement streaming for large data processing
          2. Use memory-mapped files for large datasets
          3. Implement LRU caching with size limits
          4. Add memory monitoring and alerts
          5. Optimize data serialization formats
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['Data processing components'],
        benchmarkEvidence: [`Memory-heavy operations: ${memoryHeavyOperations.length}, avg: ${avgMemoryHeavy.toFixed(2)}MB`],
      });
    }

    // Check for reliability patterns
    if (report.summary.regressions.length > 0) {
      recommendations.push({
        category: 'reliability',
        priority: 'high',
        title: 'Address Performance Regressions',
        description: `${report.summary.regressions.length} performance regressions detected in recent changes.`,
        impact: 'Maintains consistent performance, prevents performance degradation',
        implementation: `
          1. Investigate root cause of regressions
          2. Implement performance testing in CI/CD
          3. Add performance budgets and alerts
          4. Review recent code changes for performance impact
          5. Consider rolling back problematic changes
        `,
        estimatedEffort: 'medium',
        affectedComponents: ['Recently changed components'],
        benchmarkEvidence: report.summary.regressions,
      });
    }

    return recommendations;
  }

  /**
   * Calculate estimated improvements from recommendations
   */
  private calculateEstimatedImprovements(
    recommendations: OptimizationRecommendation[],
    report: PerformanceReport
  ): string[] {
    const improvements: string[] = [];

    const performanceRecs = recommendations.filter(r => r.category === 'performance');
    const memoryRecs = recommendations.filter(r => r.category === 'memory');
    const scalabilityRecs = recommendations.filter(r => r.category === 'scalability');

    if (performanceRecs.length > 0) {
      const avgDuration = report.summary.averageDuration;
      let estimatedSpeedup = 1.0;
      
      performanceRecs.forEach(rec => {
        if (rec.priority === 'high') estimatedSpeedup *= 1.3; // 30% improvement
        else if (rec.priority === 'medium') estimatedSpeedup *= 1.2; // 20% improvement
        else estimatedSpeedup *= 1.1; // 10% improvement
      });

      const estimatedNewDuration = avgDuration / estimatedSpeedup;
      improvements.push(`Performance: ${((estimatedSpeedup - 1) * 100).toFixed(1)}% faster operations (${avgDuration.toFixed(2)}ms → ${estimatedNewDuration.toFixed(2)}ms)`);
    }

    if (memoryRecs.length > 0) {
      let estimatedMemoryReduction = 1.0;
      
      memoryRecs.forEach(rec => {
        if (rec.priority === 'high') estimatedMemoryReduction *= 1.25; // 25% reduction
        else if (rec.priority === 'medium') estimatedMemoryReduction *= 1.15; // 15% reduction
        else estimatedMemoryReduction *= 1.1; // 10% reduction
      });

      const currentMemory = report.summary.memoryPeak;
      const estimatedNewMemory = currentMemory / estimatedMemoryReduction;
      improvements.push(`Memory: ${((estimatedMemoryReduction - 1) * 100).toFixed(1)}% reduction (${currentMemory.toFixed(2)}MB → ${estimatedNewMemory.toFixed(2)}MB)`);
    }

    if (scalabilityRecs.length > 0) {
      improvements.push(`Scalability: Better performance characteristics under load and with complex configurations`);
    }

    return improvements;
  }

  /**
   * Save optimization report to file
   */
  saveReport(report: OptimizationReport, outputPath?: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `optimization-report-${timestamp}.json`;
    const filePath = outputPath ? path.join(outputPath, fileName) : fileName;
    
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
    
    console.log(`🎯 Optimization report saved: ${filePath}`);
    return filePath;
  }

  /**
   * Print optimization recommendations to console
   */
  printRecommendations(report: OptimizationReport): void {
    console.log('🎯 Performance Optimization Recommendations');
    console.log('='.repeat(60));
    console.log(`Generated: ${report.timestamp}`);
    console.log(`Total recommendations: ${report.summary.totalRecommendations}`);
    console.log(`High priority: ${report.summary.highPriority}`);
    console.log(`Quick wins: ${report.summary.quickWins.length}`);
    
    if (report.summary.estimatedImprovements.length > 0) {
      console.log('\n📈 Estimated Improvements:');
      report.summary.estimatedImprovements.forEach(improvement => {
        console.log(`  • ${improvement}`);
      });
    }

    if (report.summary.quickWins.length > 0) {
      console.log('\n⚡ Quick Wins (Low Effort, High/Medium Impact):');
      report.summary.quickWins.forEach((rec, i) => {
        console.log(`  ${i + 1}. ${rec.title} (${rec.category}, ${rec.priority} priority)`);
        console.log(`     ${rec.description}`);
      });
    }

    console.log('\n📋 All Recommendations:');
    report.recommendations.forEach((rec, i) => {
      const priorityEmoji = rec.priority === 'high' ? '🔴' : rec.priority === 'medium' ? '🟡' : '🟢';
      const categoryEmoji = {
        performance: '⚡',
        memory: '🧠',
        scalability: '📈',
        reliability: '🛡️',
      }[rec.category];

      console.log(`\n${i + 1}. ${priorityEmoji} ${categoryEmoji} ${rec.title}`);
      console.log(`   Priority: ${rec.priority.toUpperCase()} | Effort: ${rec.estimatedEffort.toUpperCase()} | Category: ${rec.category}`);
      console.log(`   ${rec.description}`);
      console.log(`   💡 Impact: ${rec.impact}`);
      console.log(`   🔧 Components: ${rec.affectedComponents.join(', ')}`);
      
      if (rec.benchmarkEvidence && rec.benchmarkEvidence.length > 0) {
        console.log(`   📊 Evidence: ${rec.benchmarkEvidence.join(', ')}`);
      }
      
      console.log(`   Implementation:`);
      rec.implementation.split('\n').forEach(line => {
        if (line.trim()) {
          console.log(`     ${line.trim()}`);
        }
      });
    });

    console.log('\n' + '='.repeat(60));
  }
}

/**
 * CLI tool for generating optimization recommendations
 */
async function main() {
  const args = process.argv.slice(2);
  const reportPath = args[0];

  if (!reportPath) {
    console.log('Usage: optimization-recommendations <performance-report.json>');
    console.log('Generate optimization recommendations from a performance report');
    return;
  }

  if (!fs.existsSync(reportPath)) {
    console.error(`Error: Performance report file not found: ${reportPath}`);
    process.exit(1);
  }

  try {
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    const performanceReport: PerformanceReport = JSON.parse(reportContent);
    
    const engine = new OptimizationRecommendationsEngine();
    const optimizationReport = engine.generateRecommendations(performanceReport);
    
    engine.printRecommendations(optimizationReport);
    engine.saveReport(optimizationReport, path.dirname(reportPath));
    
  } catch (error) {
    console.error('Error processing performance report:', error);
    process.exit(1);
  }
}

// Run CLI if called directly
if (require.main === module) {
  main();
}