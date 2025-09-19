#!/usr/bin/env node

import { CLI } from './cli';
import { ConfigManager } from './config';
import { CheckExecutionEngine } from './check-execution-engine';
import { OutputFormatters } from './output-formatters';
import { calculateTotalIssues, calculateCriticalIssues } from './reviewer';
import { FailureConditionResult } from './types/config';

/**
 * Main CLI entry point for Visor
 */
export async function main(): Promise<void> {
  try {
    const cli = new CLI();
    const configManager = new ConfigManager();

    // Check for help flag before parsing
    // Filter out --cli flag which is only used to force CLI mode in GitHub Actions
    const args = process.argv.slice(2).filter(arg => arg !== '--cli');
    if (args.includes('--help') || args.includes('-h')) {
      console.log(cli.getHelpText());
      process.exit(0);
    }

    if (args.includes('--version') || args.includes('-V')) {
      console.log(cli.getVersion());
      process.exit(0);
    }

    // Parse CLI arguments
    const cliOptions = cli.parseArgs(args);

    // Load configuration
    let config;
    if (cliOptions.configPath) {
      try {
        config = await configManager.loadConfig(cliOptions.configPath);
      } catch (error) {
        console.error(
          `⚠️  Warning: ${error instanceof Error ? error.message : 'Configuration file not found'}`
        );
        console.error('Falling back to default configuration...');
        config = await configManager.getDefaultConfig();
      }
    } else {
      config = await configManager.findAndLoadConfig();
    }

    // Merge CLI options with configuration
    const mergedConfig = configManager.mergeWithCliOptions(config, cliOptions);

    // Set environment variable so other modules know the output format
    process.env.VISOR_OUTPUT_FORMAT = mergedConfig.cliOutput;

    // Only show decorative output for non-JSON formats
    if (mergedConfig.cliOutput !== 'json' && mergedConfig.cliOutput !== 'sarif') {
      console.log('🔍 Visor - AI-powered code review tool');
      console.log(`Configuration version: ${config.version}`);
    } else {
      // Send status messages to stderr for JSON/SARIF output
      console.error('🔍 Visor - AI-powered code review tool');
      console.error(`Configuration version: ${config.version}`);
    }

    // Determine which checks to run
    let checksToRun: string[];
    let isUsingConfigChecks = false;

    if (mergedConfig.cliChecks.length > 0) {
      // CLI specified checks - need validation
      checksToRun = mergedConfig.cliChecks;
    } else {
      // No CLI checks specified, use all checks from config
      checksToRun = Object.keys(config.checks || {});
      isUsingConfigChecks = true;
    }

    // Log check extraction for debugging
    if (mergedConfig.cliOutput === 'json' || mergedConfig.cliOutput === 'sarif') {
      console.error(`🔧 Debug: Extracted checks from config: ${JSON.stringify(checksToRun)}`);
      console.error(`🔧 Debug: CLI checks specified: ${JSON.stringify(mergedConfig.cliChecks)}`);
      console.error(
        `🔧 Debug: Config checks available: ${JSON.stringify(Object.keys(config.checks || {}))}`
      );
    } else {
      console.log(`🔧 Debug: Extracted checks from config: ${JSON.stringify(checksToRun)}`);
      console.log(`🔧 Debug: CLI checks specified: ${JSON.stringify(mergedConfig.cliChecks)}`);
      console.log(
        `🔧 Debug: Config checks available: ${JSON.stringify(Object.keys(config.checks || {}))}`
      );
    }

    // If no checks specified, show help
    if (checksToRun.length === 0) {
      console.error(
        '\n⚠️  No checks specified. Use --check <type> or configure checks in .visor.yaml'
      );
      console.error('Available check types: performance, architecture, security, style, all');
      process.exit(1);
    }

    // Only validate check types if they came from CLI and no custom config is provided
    // Config checks are already valid by definition, and custom configs may have their own check types
    if (!isUsingConfigChecks && !cliOptions.configPath) {
      const { invalid: invalidChecks } = CheckExecutionEngine.validateCheckTypes(checksToRun);

      if (invalidChecks.length > 0) {
        console.error(`❌ Invalid check types: ${invalidChecks.join(', ')}`);
        console.error('Available check types: performance, architecture, security, style, all');
        process.exit(1);
      }
    }

    // Initialize the check execution engine
    const executionEngine = new CheckExecutionEngine(process.cwd());

    // Check if we're in a git repository
    const repositoryStatus = await executionEngine.getRepositoryStatus();

    if (!repositoryStatus.isGitRepository) {
      console.error('❌ Not a git repository. Please run visor from within a git repository.');
      process.exit(1);
    }

    // Send repository status to stderr for JSON/SARIF, stdout for others
    const logFn =
      mergedConfig.cliOutput === 'json' || mergedConfig.cliOutput === 'sarif'
        ? console.error
        : console.log;
    logFn(`📂 Repository: ${repositoryStatus.branch} branch`);
    logFn(`📁 Files changed: ${repositoryStatus.filesChanged}`);

    if (!repositoryStatus.hasChanges) {
      logFn('ℹ️  No uncommitted changes found. Analyzing working directory state...');
    }

    try {
      // Execute the checks
      const analysisResult = await executionEngine.executeChecks({
        checks: checksToRun,
        workingDirectory: process.cwd(),
        showDetails: cliOptions.output !== 'json', // Show details for non-JSON output
        timeout: cliOptions.timeout, // Pass timeout from CLI options
        maxParallelism: cliOptions.maxParallelism, // Pass max parallelism from CLI options
        failFast: cliOptions.failFast, // Pass fail-fast from CLI options
        outputFormat: mergedConfig.cliOutput,
        config: config, // Pass the full config so engine can access check definitions
        debug: cliOptions.debug, // Pass debug flag from CLI options
      });

      // Evaluate failure conditions for each executed check
      const allFailureResults: FailureConditionResult[] = [];
      let shouldHaltExecution = false;

      for (const checkName of checksToRun) {
        try {
          const failureResults = await executionEngine.evaluateFailureConditions(
            checkName,
            analysisResult.reviewSummary,
            config
          );

          allFailureResults.push(...failureResults);

          // Check for halt condition if --fail-fast is enabled
          if (
            cliOptions.failFast &&
            failureResults.some(result => result.failed && result.haltExecution)
          ) {
            shouldHaltExecution = true;
            break;
          }
        } catch (error) {
          // Log failure condition evaluation errors but don't stop execution
          const logFn =
            mergedConfig.cliOutput === 'json' || mergedConfig.cliOutput === 'sarif'
              ? console.error
              : console.log;
          logFn(
            `⚠️  Warning: Failed to evaluate failure conditions for check '${checkName}': ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Add failure condition results to analysis result
      const enrichedAnalysisResult = {
        ...analysisResult,
        failureConditions: allFailureResults,
      };

      // Format and display the results
      await displayResults(enrichedAnalysisResult, mergedConfig.cliOutput);

      // Determine exit code based on failure conditions
      const hasFailedConditions = allFailureResults.some(result => result.failed);
      if (hasFailedConditions || shouldHaltExecution) {
        process.exit(1);
      }
    } catch (error) {
      console.error(
        '❌ Error executing checks:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

/**
 * Display analysis results in the specified format
 */
async function displayResults(
  result: import('./output-formatters').AnalysisResult,
  outputFormat: string
): Promise<void> {
  switch (outputFormat) {
    case 'json':
      // Pure JSON output to stdout
      const jsonOutput = OutputFormatters.formatAsJSON(result, {
        showDetails: true,
        groupByCategory: true,
        includeFiles: true,
        includeTimestamp: true,
      });
      console.log(jsonOutput);
      break;

    case 'sarif':
      // Pure SARIF output to stdout
      const sarifOutput = OutputFormatters.formatAsSarif(result, {
        showDetails: true,
        groupByCategory: true,
        includeFiles: true,
        includeTimestamp: true,
      });
      console.log(sarifOutput);
      break;

    case 'markdown':
      // Decorative headers allowed for markdown
      console.log('\n' + '='.repeat(80));
      console.log('🎯 ANALYSIS RESULTS');
      console.log('='.repeat(80));

      const markdownOutput = OutputFormatters.formatAsMarkdown(result, {
        showDetails: true,
        groupByCategory: true,
        includeFiles: true,
        includeTimestamp: true,
      });
      console.log(markdownOutput);

      // Show summary for markdown
      const totalIssues = calculateTotalIssues(result.reviewSummary.issues);
      const criticalIssues = calculateCriticalIssues(result.reviewSummary.issues);
      console.log(`\n📋 Analysis completed`);

      if (totalIssues > 0) {
        console.log(`📋 Found ${totalIssues} issues (${criticalIssues} critical)`);
      }

      console.log(`⏱️  Execution time: ${result.executionTime}ms`);
      break;

    case 'table':
    default:
      // Decorative headers allowed for table
      console.log('\n' + '='.repeat(80));
      console.log('🎯 ANALYSIS RESULTS');
      console.log('='.repeat(80));

      const tableOutput = OutputFormatters.formatAsTable(result, {
        showDetails: true,
        groupByCategory: true,
        includeFiles: true,
        includeTimestamp: true,
      });
      console.log(tableOutput);

      // Show summary for table
      const tableTotalIssues = calculateTotalIssues(result.reviewSummary.issues);
      const tableCriticalIssues = calculateCriticalIssues(result.reviewSummary.issues);
      console.log(`\n📋 Analysis completed`);

      if (tableTotalIssues > 0) {
        console.log(`📋 Found ${tableTotalIssues} issues (${tableCriticalIssues} critical)`);
      }

      console.log(`⏱️  Execution time: ${result.executionTime}ms`);
      break;
  }
}

// Run the CLI if this file is executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
  });
}
