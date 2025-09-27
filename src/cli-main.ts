#!/usr/bin/env node

import { CLI } from './cli';
import { ConfigManager } from './config';
import { CheckExecutionEngine } from './check-execution-engine';
import { OutputFormatters, AnalysisResult } from './output-formatters';
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
      } catch (error) {
        // Show the actual error message, not just assume "file not found"
        if (error instanceof Error) {
          console.error(`❌ Error loading configuration from ${options.configPath}:`);
          console.error(`   ${error.message}`);

          // Provide helpful hints based on the error type
          if (error.message.includes('not found')) {
            console.error('\n💡 Hint: Check that the file path is correct and the file exists.');
            console.error('   You can use an absolute path: --config $(pwd)/.visor.yaml');
          } else if (error.message.includes('Invalid YAML')) {
            console.error(
              '\n💡 Hint: Check your YAML syntax. You can validate it at https://www.yamllint.com/'
            );
          } else if (error.message.includes('extends')) {
            console.error(
              '\n💡 Hint: Check that extended configuration files exist and are accessible.'
            );
          } else if (error.message.includes('permission')) {
            console.error('\n💡 Hint: Check file permissions. The file must be readable.');
          }
        } else {
          console.error(`❌ Error loading configuration: ${error}`);
        }

        // Exit with error when explicit config path fails
        console.error(
          '\n🛑 Exiting: Cannot proceed when specified configuration file fails to load.'
        );
        process.exit(1);
      }
    } else {
      // Auto-discovery mode - fallback to defaults is OK
      config = await configManager
        .findAndLoadConfig()
        .catch(() => configManager.getDefaultConfig());
    }

    // Determine checks to run and validate check types early
    let checksToRun = options.checks.length > 0 ? options.checks : Object.keys(config.checks || {});

    // Validate that all requested checks exist in the configuration
    const availableChecks = Object.keys(config.checks || {});
    const invalidChecks = checksToRun.filter(check => !availableChecks.includes(check));
    if (invalidChecks.length > 0) {
      console.error(`❌ Error: No configuration found for check: ${invalidChecks[0]}`);
      process.exit(1);
    }

    // Include dependencies of requested checks
    const checksWithDependencies = new Set(checksToRun);
    const addDependencies = (checkName: string) => {
      const checkConfig = config.checks?.[checkName];
      if (checkConfig?.depends_on) {
        for (const dep of checkConfig.depends_on) {
          if (!checksWithDependencies.has(dep)) {
            checksWithDependencies.add(dep);
            addDependencies(dep); // Recursively add dependencies of dependencies
          }
        }
      }
    };

    // Add all dependencies
    for (const check of checksToRun) {
      addDependencies(check);
    }

    // Update checksToRun to include dependencies
    checksToRun = Array.from(checksWithDependencies);

    // Use stderr for status messages when outputting formatted results to stdout
    const logFn = console.error;

    // Determine if we should include code context (diffs)
    // In CLI mode (local), we do smart detection. PR mode always includes context.
    const isPRContext = false; // This is CLI mode, not GitHub Action
    let includeCodeContext = false;

    if (isPRContext) {
      // ALWAYS include full context in PR/GitHub Action mode
      includeCodeContext = true;
      logFn('📝 Code context: ENABLED (PR context - always included)');
    } else if (options.codeContext === 'enabled') {
      includeCodeContext = true;
      logFn('📝 Code context: ENABLED (forced by --enable-code-context)');
    } else if (options.codeContext === 'disabled') {
      includeCodeContext = false;
      logFn('📝 Code context: DISABLED (forced by --disable-code-context)');
    } else {
      // Auto-detect based on schemas (CLI mode only)
      const hasCodeReviewSchema = checksToRun.some(
        check => config.checks?.[check]?.schema === 'code-review'
      );
      includeCodeContext = hasCodeReviewSchema;
      if (hasCodeReviewSchema) {
        logFn('📝 Code context: ENABLED (code-review schema detected in local mode)');
      } else {
        logFn('📝 Code context: DISABLED (no code-review schema found in local mode)');
      }
    }

    // Get repository info using GitRepositoryAnalyzer
    const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
    const analyzer = new GitRepositoryAnalyzer(process.cwd());

    let repositoryInfo: import('./git-repository-analyzer').GitRepositoryInfo;
    try {
      repositoryInfo = await analyzer.analyzeRepository(includeCodeContext);
    } catch (error) {
      console.error('❌ Error analyzing git repository:', error);
      console.error('💡 Make sure you are in a git repository or initialize one with "git init"');
      process.exit(1);
    }

    // Check if we're in a git repository
    if (!repositoryInfo.isGitRepository) {
      console.error('❌ Error: Not a git repository. Run "git init" to initialize a repository.');
      process.exit(1);
    }

    // Check if there are any changes to analyze (only when code context is needed)
    if (includeCodeContext && repositoryInfo.files.length === 0) {
      console.error('❌ Error: No changes to analyze. Make some file changes first.');
      process.exit(1);
    }

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

    // Build tag filter from CLI options
    const tagFilter: import('./types/config').TagFilter | undefined =
      options.tags || options.excludeTags
        ? {
            include: options.tags,
            exclude: options.excludeTags,
          }
        : undefined;

    // Convert repository info to PRInfo format
    const prInfo = analyzer.toPRInfo(repositoryInfo, includeCodeContext);

    // Store the includeCodeContext flag in prInfo for downstream use
    (prInfo as any).includeCodeContext = includeCodeContext;

    // Execute checks with proper parameters
    const groupedResults = await engine.executeGroupedChecks(
      prInfo,
      checksToRun,
      options.timeout,
      config,
      options.output,
      options.debug || false,
      options.maxParallelism,
      options.failFast,
      tagFilter
    );

    // Format output based on format type
    let output: string;
    if (options.output === 'json') {
      output = JSON.stringify(groupedResults, null, 2);
    } else if (options.output === 'sarif') {
      // Build analysis result and format as SARIF
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResults)
            .flatMap((r: CheckResult[]) => r.map((check: CheckResult) => check.issues || []).flat())
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: checksToRun,
      };
      output = OutputFormatters.formatAsSarif(analysisResult);
    } else if (options.output === 'markdown') {
      // Create analysis result for markdown formatting
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResults)
            .flatMap((r: CheckResult[]) => r.map((check: CheckResult) => check.issues || []).flat())
            .flat(),
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
    } else if (error instanceof Error && error.message.includes('No API key configured')) {
      console.error('\n❌ Error: No API key or credentials configured for AI provider.');
      console.error('Please set one of the following:');
      console.error('\nFor Google Gemini:');
      console.error('  export GOOGLE_API_KEY="your-api-key"');
      console.error('\nFor Anthropic Claude:');
      console.error('  export ANTHROPIC_API_KEY="your-api-key"');
      console.error('\nFor OpenAI:');
      console.error('  export OPENAI_API_KEY="your-api-key"');
      console.error('\nFor AWS Bedrock:');
      console.error('  export AWS_ACCESS_KEY_ID="your-access-key"');
      console.error('  export AWS_SECRET_ACCESS_KEY="your-secret-key"');
      console.error('  export AWS_REGION="us-east-1"');
      console.error('\nOr use API key authentication for Bedrock:');
      console.error('  export AWS_BEDROCK_API_KEY="your-api-key"\n');
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
