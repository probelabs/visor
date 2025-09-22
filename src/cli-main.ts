#!/usr/bin/env node

import { CLI } from './cli';
import { ConfigManager } from './config';
import { CheckExecutionEngine } from './check-execution-engine';
import { OutputFormatters, AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { CheckResult } from './reviewer';

/**
 * Main CLI entry point for Visor
 */
export async function main(): Promise<void> {
  try {
    const cli = new CLI();
    const configManager = new ConfigManager();

    // Filter out the --cli flag if it exists (used to force CLI mode in GitHub Actions)
    const filteredArgv = process.argv.filter(arg => arg !== '--cli');

    // Parse arguments using the CLI class
    const options = cli.parseArgs(filteredArgv);

    // Handle help and version flags
    if (options.help) {
      console.log(cli.getHelpText());
      process.exit(0);
    }

    if (options.version) {
      console.log(cli.getVersion());
      process.exit(0);
    }

    // Load configuration
    const config = options.configPath
      ? await configManager.loadConfig(options.configPath)
      : await configManager.findAndLoadConfig().catch(() => configManager.getDefaultConfig());

    // Get repository info using GitRepositoryAnalyzer
    const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
    const analyzer = new GitRepositoryAnalyzer(process.cwd());
    const repositoryInfo = await analyzer.analyzeRepository();

    // Determine checks to run
    const checksToRun =
      options.checks.length > 0 ? options.checks : Object.keys(config.checks || {});

    console.log('🔍 Visor - AI-powered code review tool');
    console.log(`Configuration version: ${config.version}`);
    console.log(`Configuration source: ${options.configPath || 'default search locations'}`);

    // Show registered providers if in debug mode
    if (options.debug) {
      const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
      const registry = CheckProviderRegistry.getInstance();
      console.log('Registered providers:', registry.getAvailableProviders().join(', '));
    }

    console.log(`📂 Repository: ${repositoryInfo.base} branch`);
    console.log(`📁 Files changed: ${repositoryInfo.files?.length || 0}`);
    console.log('🔍 Analyzing local git repository...');
    console.log(`🤖 Executing checks: ${checksToRun.join(', ')}`);

    // Create CheckExecutionEngine for running checks
    const engine = new CheckExecutionEngine();

    // Execute checks with proper parameters (cast to PRInfo)
    const groupedResults = await engine.executeGroupedChecks(
      repositoryInfo as unknown as PRInfo,
      checksToRun,
      options.timeout,
      config,
      options.output,
      options.debug || false
    );

    // Format output based on format type
    let output: string;
    if (options.output === 'json') {
      output = JSON.stringify(groupedResults, null, 2);
    } else {
      // Create analysis result for table formatting
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResults)
            .flatMap((r: CheckResult[]) => r.map((check: CheckResult) => check.issues || []).flat())
            .flat(),
          suggestions: [], // Suggestions are now embedded in issues
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: checksToRun,
      };
      output = OutputFormatters.formatAsTable(analysisResult, { showDetails: true });
    }

    console.log(output);

    // Check for critical issues
    const allResults = Object.values(groupedResults).flat();
    const criticalCount = allResults.reduce((sum, result: any) => {
      const issues = result.content?.issues || [];
      return sum + issues.filter((i: any) => i.severity === 'critical').length;
    }, 0);

    if (criticalCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// If called directly, run main
if (require.main === module) {
  main();
}
