#!/usr/bin/env node

import { CLI } from './cli';
import { ConfigManager } from './config';
import { CheckExecutionEngine } from './check-execution-engine';
import { OutputFormatters, AnalysisResult } from './output-formatters';
import { CheckResult, GroupedCheckResults } from './reviewer';
import { PRInfo } from './pr-analyzer';
import { logger, configureLoggerFromCli } from './logger';
import { initTelemetry, shutdownTelemetry } from './telemetry/opentelemetry';
import { withActiveSpan, setSpanAttributes } from './telemetry/trace-helpers';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

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
    const explicitChecks =
      options.checks.length > 0
        ? new Set<string>(options.checks.map(check => check.toString()))
        : null;

    // Set environment variables early for proper logging in all modules
    process.env.VISOR_OUTPUT_FORMAT = options.output;
    process.env.VISOR_DEBUG = options.debug ? 'true' : 'false';
    // Configure centralized logger
    configureLoggerFromCli({
      output: options.output,
      debug: options.debug,
      verbose: options.verbose,
      quiet: options.quiet,
    });

    // Handle help and version flags
    if (options.help) {
      console.log(cli.getHelpText());
      process.exit(0);
    }

    if (options.version) {
      console.log(cli.getVersion());
      process.exit(0);
    }

    // Configure logger based on output format and verbosity
    logger.configure({
      outputFormat: options.output,
      debug: options.debug,
      verbose: options.verbose,
      quiet: options.quiet,
    });

    // Print runtime banner (info level): Visor + Probe versions
    // Banner is automatically suppressed for JSON/SARIF by logger configuration
    try {
      const visorVersion =
        process.env.VISOR_VERSION || (require('../package.json')?.version ?? 'dev');
      let probeVersion = process.env.PROBE_VERSION || 'unknown';
      if (!process.env.PROBE_VERSION) {
        try {
          probeVersion = require('@probelabs/probe/package.json')?.version ?? 'unknown';
        } catch {
          // ignore if dependency metadata not available (tests, local)
        }
      }
      logger.info(`Visor ${visorVersion} • Probe ${probeVersion} • Node ${process.version}`);
    } catch {
      // If anything goes wrong reading versions, do not block execution
    }

    // Load configuration
    let config;
    if (options.configPath) {
      try {
        logger.step('Loading configuration');
        config = await configManager.loadConfig(options.configPath);
      } catch (error) {
        // Show the actual error message, not just assume "file not found"
        if (error instanceof Error) {
          logger.error(`❌ Error loading configuration from ${options.configPath}:`);
          logger.error(`   ${error.message}`);

          // Provide helpful hints based on the error type
          if (error.message.includes('not found')) {
            logger.warn('\n💡 Hint: Check that the file path is correct and the file exists.');
            logger.warn('   You can use an absolute path: --config $(pwd)/.visor.yaml');
          } else if (error.message.includes('Invalid YAML')) {
            logger.warn(
              '\n💡 Hint: Check your YAML syntax. You can validate it at https://www.yamllint.com/'
            );
          } else if (error.message.includes('extends')) {
            logger.warn(
              '\n💡 Hint: Check that extended configuration files exist and are accessible.'
            );
          } else if (error.message.includes('permission')) {
            logger.warn('\n💡 Hint: Check file permissions. The file must be readable.');
          }
        } else {
          logger.error(`❌ Error loading configuration: ${error}`);
        }

        // Exit with error when explicit config path fails
        logger.error(
          '\n🛑 Exiting: Cannot proceed when specified configuration file fails to load.'
        );
        process.exit(1);
      }
    } else {
      // Auto-discovery mode - fallback to defaults is OK
      logger.step('Discovering configuration');
      config = await configManager
        .findAndLoadConfig()
        .catch(() => configManager.getDefaultConfig());
    }

    // Initialize telemetry (config with CLI/env overrides)
    const runId = uuidv4();
    const t = (config?.telemetry || {}) as any;
    // Apply CLI → env overrides for telemetry
    if (options.telemetry === true) process.env.VISOR_TELEMETRY_ENABLED = 'true';
    if (options.telemetrySink) process.env.VISOR_TELEMETRY_SINK = options.telemetrySink as any;
    if (options.telemetryEndpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = options.telemetryEndpoint;
    if (options.traceReport) process.env.VISOR_TRACE_REPORT = 'true';
    if (options.autoInstrument) process.env.VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS = 'true';

    const telemetryEnabled = process.env.VISOR_TELEMETRY_ENABLED === 'true' || t.enabled === true;
    await initTelemetry({
      enabled: telemetryEnabled,
      sink: ((process.env.VISOR_TELEMETRY_SINK as any) || t.sink || 'file') as any,
      otlp: {
        endpoint:
          process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
          t?.otlp?.endpoint,
        headers: process.env.OTEL_EXPORTER_OTLP_HEADERS || t?.otlp?.headers,
        protocol: (t?.otlp?.protocol as any) || 'http',
      },
      file: { dir: process.env.VISOR_TRACE_DIR || t?.file?.dir, runId, ndjson: t?.file?.ndjson ?? true },
      patchConsole: true,
      autoInstrument:
        process.env.VISOR_TELEMETRY_AUTO_INSTRUMENTATIONS === 'true' || t?.tracing?.auto_instrumentations === true,
      traceReport: process.env.VISOR_TRACE_REPORT === 'true' || t?.tracing?.trace_report?.enabled === true,
    });

    // Determine checks to run and validate check types early
    let checksToRun = options.checks.length > 0 ? options.checks : Object.keys(config.checks || {});

    // Validate that all requested checks exist in the configuration
    const availableChecks = Object.keys(config.checks || {});
    const invalidChecks = checksToRun.filter(check => !availableChecks.includes(check));
    if (invalidChecks.length > 0) {
      logger.error(`❌ Error: No configuration found for check: ${invalidChecks[0]}`);
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
    // Suppress all status messages when outputting JSON to avoid breaking parsers
    const logFn = (msg: string) => logger.info(msg);

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
      if (hasCodeReviewSchema)
        logFn('📝 Code context: ENABLED (code-review schema detected in local mode)');
      else logFn('📝 Code context: DISABLED (no code-review schema found in local mode)');
    }

    // Get repository info using GitRepositoryAnalyzer
    const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
    const analyzer = new GitRepositoryAnalyzer(process.cwd());

    let repositoryInfo: import('./git-repository-analyzer').GitRepositoryInfo;
    try {
      logger.step('Analyzing repository');
      repositoryInfo = await analyzer.analyzeRepository(includeCodeContext);
    } catch (error) {
      logger.error(
        '❌ Error analyzing git repository: ' +
          (error instanceof Error ? error.message : String(error))
      );
      logger.warn('💡 Make sure you are in a git repository or initialize one with "git init"');
      process.exit(1);
    }

    // Check if we're in a git repository
    if (!repositoryInfo.isGitRepository) {
      logger.error('❌ Error: Not a git repository. Run "git init" to initialize a repository.');
      process.exit(1);
    }

    logger.info('🔍 Visor - AI-powered code review tool');
    logger.info(`Configuration version: ${config.version}`);
    logger.verbose(`Configuration source: ${options.configPath || 'default search locations'}`);

    // Check if there are any changes to analyze (only when code context is needed)
    if (includeCodeContext && repositoryInfo.files.length === 0) {
      logger.error('❌ Error: No changes to analyze. Make some file changes first.');
      process.exit(1);
    }

    // Show registered providers if in debug mode
    if (options.debug) {
      const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
      const registry = CheckProviderRegistry.getInstance();
      logger.debug('Registered providers: ' + registry.getAvailableProviders().join(', '));
    }

    logger.info(`📂 Repository: ${repositoryInfo.base} branch`);
    logger.info(`📁 Files changed: ${repositoryInfo.files?.length || 0}`);
    logger.step(`Executing ${checksToRun.length} check(s)`);
    logger.verbose(`Checks: ${checksToRun.join(', ')}`);

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
    const prInfoWithContext = prInfo as PRInfo & { includeCodeContext?: boolean };
    prInfoWithContext.includeCodeContext = includeCodeContext;

    // Execute checks with proper parameters
    const executionResult = await withActiveSpan(
      'visor.run',
      {
        'visor.run.id': runId,
        'visor.run.mode': 'cli',
        'visor.max_parallelism': options.maxParallelism ?? config.max_parallelism ?? 3,
        'visor.fail_fast': !!(options.failFast ?? config.fail_fast ?? false),
        'visor.files.changed_count': repositoryInfo.files?.length || 0,
      },
      async () =>
        await engine.executeGroupedChecks(
          prInfo,
          checksToRun,
          options.timeout,
          config,
          options.output,
          options.debug || false,
          options.maxParallelism,
          options.failFast,
          tagFilter
        )
    );

    // Extract results and statistics from the execution result
    const { results: groupedResults, statistics: executionStatistics } = executionResult;

    const shouldFilterResults =
      explicitChecks && explicitChecks.size > 0 && !explicitChecks.has('all');

    const groupedResultsToUse: GroupedCheckResults = shouldFilterResults
      ? (Object.fromEntries(
          Object.entries(groupedResults)
            .map(([group, checkResults]) => [
              group,
              checkResults.filter(check => explicitChecks!.has(check.checkName)),
            ])
            .filter(([, checkResults]) => checkResults.length > 0)
        ) as GroupedCheckResults)
      : groupedResults;

    if (shouldFilterResults) {
      for (const [group, checkResults] of Object.entries(groupedResults)) {
        for (const check of checkResults) {
          if (check.issues && check.issues.length > 0 && !explicitChecks!.has(check.checkName)) {
            if (!groupedResultsToUse[group]) {
              groupedResultsToUse[group] = [];
            }
            const alreadyIncluded = groupedResultsToUse[group].some(
              existing => existing.checkName === check.checkName
            );
            if (!alreadyIncluded) {
              groupedResultsToUse[group].push(check);
            }
          }
        }
      }
    }

    // Get executed check names
    const executedCheckNames = Array.from(
      new Set(
        Object.entries(groupedResultsToUse).flatMap(([, checks]) =>
          checks.map(check => check.checkName)
        )
      )
    );

    // Format output based on format type
    logger.step(`Formatting results as ${options.output}`);
    let output: string;
    if (options.output === 'json') {
      output = JSON.stringify(groupedResultsToUse, null, 2);
    } else if (options.output === 'sarif') {
      // Build analysis result and format as SARIF
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsSarif(analysisResult);
    } else if (options.output === 'markdown') {
      // Create analysis result for markdown formatting
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsMarkdown(analysisResult);
    } else {
      // Create analysis result for table formatting (default)
      const analysisResult: AnalysisResult = {
        repositoryInfo,
        reviewSummary: {
          issues: Object.values(groupedResultsToUse)
            .flatMap(checks => checks.flatMap(check => check.issues || []))
            .flat(),
        },
        executionTime: 0,
        timestamp: new Date().toISOString(),
        checksExecuted: executedCheckNames,
        executionStatistics,
        isCodeReview: includeCodeContext,
      };
      output = OutputFormatters.formatAsTable(analysisResult, { showDetails: true });
    }

    // Emit or save output
    if (options.outputFile) {
      try {
        const outPath = path.resolve(process.cwd(), options.outputFile);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, output, 'utf8');
        logger.success(`Saved ${options.output} output to ${outPath}`);
      } catch (writeErr) {
        logger.error(
          `Failed to write output to file: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`
        );
        process.exit(1);
      }
    } else {
      console.log(output);
    }

    // Summarize execution (stderr only; suppressed in JSON/SARIF unless verbose/debug)
    const allResults = Object.values(groupedResultsToUse).flatMap(checks => checks);
    const allIssues = allResults.flatMap((r: CheckResult) => r.issues || []);
    const counts = allIssues.reduce(
      (acc, issue: { severity?: string }) => {
        const sev = (issue.severity || 'info').toLowerCase();
        acc.total++;
        if (sev === 'critical') acc.critical++;
        else if (sev === 'error') acc.error++;
        else if (sev === 'warning' || sev === 'warn') acc.warning++;
        else acc.info++;
        return acc;
      },
      { total: 0, critical: 0, error: 0, warning: 0, info: 0 }
    );

    logger.success(
      `Completed ${executedCheckNames.length} check(s): ${counts.total} issues (${counts.critical} critical, ${counts.error} error, ${counts.warning} warning)`
    );
    logger.verbose(`Checks executed: ${executedCheckNames.join(', ')}`);

    // Check for critical issues
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

    // Cleanup AI sessions before exit to prevent process hanging
    const { SessionRegistry } = await import('./session-registry');
    const sessionRegistry = SessionRegistry.getInstance();
    if (sessionRegistry.getActiveSessionIds().length > 0) {
      logger.debug(
        `🧹 Cleaning up ${sessionRegistry.getActiveSessionIds().length} active AI sessions...`
      );
      sessionRegistry.clearAllSessions();
    }

    // Force exit to prevent hanging from unclosed resources (MCP connections, etc.)
    // This is necessary because some async resources may not be properly cleaned up
    // and can keep the event loop alive indefinitely
    const exitCode = criticalCount > 0 || hasRepositoryError ? 1 : 0;
    await shutdownTelemetry().catch(() => {});
    process.exit(exitCode);
  } catch (error) {
    // Import error classes dynamically to avoid circular dependencies
    const { ClaudeCodeSDKNotInstalledError, ClaudeCodeAPIKeyMissingError } = await import(
      './providers/claude-code-check-provider'
    ).catch(() => ({ ClaudeCodeSDKNotInstalledError: null, ClaudeCodeAPIKeyMissingError: null }));

    // Provide user-friendly error messages for known errors
    if (ClaudeCodeSDKNotInstalledError && error instanceof ClaudeCodeSDKNotInstalledError) {
      logger.error('\n❌ Error: Claude Code SDK is not installed.');
      logger.error('To use the claude-code provider, you need to install the required packages:');
      logger.error('\n  npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk');
      logger.error('\nOr if using yarn:');
      logger.error('\n  yarn add @anthropic/claude-code-sdk @modelcontextprotocol/sdk\n');
    } else if (ClaudeCodeAPIKeyMissingError && error instanceof ClaudeCodeAPIKeyMissingError) {
      logger.error('\n❌ Error: No API key found for Claude Code provider.');
      logger.error('Please set one of the following environment variables:');
      logger.error('  - CLAUDE_CODE_API_KEY');
      logger.error('  - ANTHROPIC_API_KEY');
      logger.error('\nExample:');
      logger.error('  export CLAUDE_CODE_API_KEY="your-api-key-here"\n');
    } else if (error instanceof Error && error.message.includes('No API key configured')) {
      logger.error('\n❌ Error: No API key or credentials configured for AI provider.');
      logger.error('Please set one of the following:');
      logger.error('\nFor Google Gemini:');
      logger.error('  export GOOGLE_API_KEY="your-api-key"');
      logger.error('\nFor Anthropic Claude:');
      logger.error('  export ANTHROPIC_API_KEY="your-api-key"');
      logger.error('\nFor OpenAI:');
      logger.error('  export OPENAI_API_KEY="your-api-key"');
      logger.error('\nFor AWS Bedrock:');
      logger.error('  export AWS_ACCESS_KEY_ID="your-access-key"');
      logger.error('  export AWS_SECRET_ACCESS_KEY="your-secret-key"');
      logger.error('  export AWS_REGION="us-east-1"');
      logger.error('\nOr use API key authentication for Bedrock:');
      logger.error('  export AWS_BEDROCK_API_KEY="your-api-key"\n');
    } else {
      logger.error('❌ Error: ' + (error instanceof Error ? error.message : String(error)));
    }
    await shutdownTelemetry().catch(() => {});
    process.exit(1);
  }
}

// If called directly, run main
if (require.main === module) {
  main();
}
