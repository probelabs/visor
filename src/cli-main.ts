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

    // Set environment variables early for proper logging in all modules
    process.env.VISOR_OUTPUT_FORMAT = options.output;
    process.env.VISOR_DEBUG = options.debug ? 'true' : 'false';

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
    let config;
    if (options.configPath) {
      try {
        config = await configManager.loadConfig(options.configPath);
      } catch {
        console.error(`⚠️ Warning: Configuration file not found: ${options.configPath}`);
        console.error('Falling back to default configuration');
        config = await configManager
          .findAndLoadConfig()
          .catch(() => configManager.getDefaultConfig());
      }
    } else {
      config = await configManager
        .findAndLoadConfig()
        .catch(() => configManager.getDefaultConfig());
    }

    // Get repository info using GitRepositoryAnalyzer
    const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
    const analyzer = new GitRepositoryAnalyzer(process.cwd());
    const repositoryInfo = await analyzer.analyzeRepository();

    // Determine checks to run and validate check types early
    const checksToRun =
      options.checks.length > 0 ? options.checks : Object.keys(config.checks || {});

    // Validate that all requested checks exist in the configuration
    const availableChecks = Object.keys(config.checks || {});
    const invalidChecks = checksToRun.filter(check => !availableChecks.includes(check));
    if (invalidChecks.length > 0) {
      console.error(`❌ Error: No configuration found for check: ${invalidChecks[0]}`);
      process.exit(1);
    }

    // Check if we're in a git repository and handle error early
    if (!repositoryInfo.isGitRepository) {
      console.error('❌ Error: Not a git repository or no changes found');
      process.exit(1);
    }

    // Use stderr for status messages when outputting formatted results to stdout
    const logFn = console.error;

    logFn('🔍 Visor - AI-powered code review tool');
    logFn(`Configuration version: ${config.version}`);
    logFn(`Configuration source: ${options.configPath || 'default search locations'}`);

    // Show registered providers if in debug mode
    if (options.debug) {
      const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
      const registry = CheckProviderRegistry.getInstance();
      logFn('Registered providers:', registry.getAvailableProviders().join(', '));
    }

    logFn(`📂 Repository: ${repositoryInfo.base} branch`);
    logFn(`📁 Files changed: ${repositoryInfo.files?.length || 0}`);
    logFn('🔍 Analyzing local git repository...');
    logFn(`🤖 Executing checks: ${checksToRun.join(', ')}`);

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
    } else if (options.output === 'sarif') {
      // For SARIF output, we need to convert to SARIF format
      // For now, output as JSON until proper SARIF formatting is implemented
      output = JSON.stringify(groupedResults, null, 2);
    } else if (options.output === 'markdown') {
      // Create analysis result for markdown formatting
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
      output = OutputFormatters.formatAsMarkdown(analysisResult);
    } else {
      // Create analysis result for table formatting (default)
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
    const criticalCount = allResults.reduce((sum, result: CheckResult) => {
      const issues = result.issues || [];
      return (
        sum + issues.filter((issue: { severity: string }) => issue.severity === 'critical').length
      );
    }, 0);

    // Check for git repository errors or other fatal errors
    const hasRepositoryError = allResults.some((result: CheckResult) => {
      return result.content.includes('Not a git repository');
    });

    if (criticalCount > 0 || hasRepositoryError) {
      process.exit(1);
    }
  } catch (error) {
    // Import error classes dynamically to avoid circular dependencies
    const { ClaudeCodeSDKNotInstalledError, ClaudeCodeAPIKeyMissingError } = await import(
      './providers/claude-code-check-provider'
    ).catch(() => ({ ClaudeCodeSDKNotInstalledError: null, ClaudeCodeAPIKeyMissingError: null }));

    // Provide user-friendly error messages for known errors
    if (ClaudeCodeSDKNotInstalledError && error instanceof ClaudeCodeSDKNotInstalledError) {
      console.error('\n❌ Error: Claude Code SDK is not installed.');
      console.error('To use the claude-code provider, you need to install the required packages:');
      console.error('\n  npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk');
      console.error('\nOr if using yarn:');
      console.error('\n  yarn add @anthropic/claude-code-sdk @modelcontextprotocol/sdk\n');
    } else if (ClaudeCodeAPIKeyMissingError && error instanceof ClaudeCodeAPIKeyMissingError) {
      console.error('\n❌ Error: No API key found for Claude Code provider.');
      console.error('Please set one of the following environment variables:');
      console.error('  - CLAUDE_CODE_API_KEY');
      console.error('  - ANTHROPIC_API_KEY');
      console.error('\nExample:');
      console.error('  export CLAUDE_CODE_API_KEY="your-api-key-here"\n');
    } else {
      console.error('❌ Error:', error instanceof Error ? error.message : error);
    }
    process.exit(1);
  }
}

// If called directly, run main
if (require.main === module) {
  main();
}
