#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
const cli_1 = require("./cli");
const config_1 = require("./config");
const check_execution_engine_1 = require("./check-execution-engine");
const output_formatters_1 = require("./output-formatters");
const reviewer_1 = require("./reviewer");
/**
 * Main CLI entry point for Visor
 */
async function main() {
    try {
        const cli = new cli_1.CLI();
        const configManager = new config_1.ConfigManager();
        // Check for help flag before parsing
        const args = process.argv.slice(2);
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
            }
            catch (error) {
                console.error(`⚠️  Warning: ${error instanceof Error ? error.message : 'Configuration file not found'}`);
                console.error('Falling back to default configuration...');
                config = await configManager.getDefaultConfig();
            }
        }
        else {
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
        }
        else {
            // Send status messages to stderr for JSON/SARIF output
            console.error('🔍 Visor - AI-powered code review tool');
            console.error(`Configuration version: ${config.version}`);
        }
        // Determine which checks to run
        const checksToRun = mergedConfig.cliChecks.length > 0 ? mergedConfig.cliChecks : Object.keys(config.checks || {});
        // Log check extraction for debugging
        if (mergedConfig.cliOutput === 'json' || mergedConfig.cliOutput === 'sarif') {
            console.error(`🔧 Debug: Extracted checks from config: ${JSON.stringify(checksToRun)}`);
            console.error(`🔧 Debug: CLI checks specified: ${JSON.stringify(mergedConfig.cliChecks)}`);
            console.error(`🔧 Debug: Config checks available: ${JSON.stringify(Object.keys(config.checks || {}))}`);
        }
        else {
            console.log(`🔧 Debug: Extracted checks from config: ${JSON.stringify(checksToRun)}`);
            console.log(`🔧 Debug: CLI checks specified: ${JSON.stringify(mergedConfig.cliChecks)}`);
            console.log(`🔧 Debug: Config checks available: ${JSON.stringify(Object.keys(config.checks || {}))}`);
        }
        // If no checks specified, show help
        if (checksToRun.length === 0) {
            console.error('\n⚠️  No checks specified. Use --check <type> or configure checks in visor.config.yaml');
            console.error('Available check types: performance, architecture, security, style, all');
            process.exit(1);
        }
        // Validate check types
        const { valid: validChecks, invalid: invalidChecks } = check_execution_engine_1.CheckExecutionEngine.validateCheckTypes(checksToRun);
        if (invalidChecks.length > 0) {
            console.error(`❌ Invalid check types: ${invalidChecks.join(', ')}`);
            console.error('Available check types: performance, architecture, security, style, all');
            process.exit(1);
        }
        // Initialize the check execution engine
        const executionEngine = new check_execution_engine_1.CheckExecutionEngine(process.cwd());
        // Check if we're in a git repository
        const repositoryStatus = await executionEngine.getRepositoryStatus();
        if (!repositoryStatus.isGitRepository) {
            console.error('❌ Not a git repository. Please run visor from within a git repository.');
            process.exit(1);
        }
        // Send repository status to stderr for JSON/SARIF, stdout for others
        const logFn = mergedConfig.cliOutput === 'json' || mergedConfig.cliOutput === 'sarif'
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
                checks: validChecks,
                workingDirectory: process.cwd(),
                showDetails: cliOptions.output !== 'json', // Show details for non-JSON output
                timeout: cliOptions.timeout, // Pass timeout from CLI options
                outputFormat: mergedConfig.cliOutput,
                config: config, // Pass the full config so engine can access check definitions
            });
            // Format and display the results
            await displayResults(analysisResult, mergedConfig.cliOutput);
        }
        catch (error) {
            console.error('❌ Error executing checks:', error instanceof Error ? error.message : 'Unknown error');
            process.exit(1);
        }
    }
    catch (error) {
        console.error('❌ Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}
/**
 * Display analysis results in the specified format
 */
async function displayResults(result, outputFormat) {
    switch (outputFormat) {
        case 'json':
            // Pure JSON output to stdout
            const jsonOutput = output_formatters_1.OutputFormatters.formatAsJSON(result, {
                showDetails: true,
                groupByCategory: true,
                includeFiles: true,
                includeTimestamp: true,
            });
            console.log(jsonOutput);
            break;
        case 'sarif':
            // Pure SARIF output to stdout
            const sarifOutput = output_formatters_1.OutputFormatters.formatAsSarif(result, {
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
            const markdownOutput = output_formatters_1.OutputFormatters.formatAsMarkdown(result, {
                showDetails: true,
                groupByCategory: true,
                includeFiles: true,
                includeTimestamp: true,
            });
            console.log(markdownOutput);
            // Show summary for markdown
            const score = (0, reviewer_1.calculateOverallScore)(result.reviewSummary.issues);
            const totalIssues = (0, reviewer_1.calculateTotalIssues)(result.reviewSummary.issues);
            const criticalIssues = (0, reviewer_1.calculateCriticalIssues)(result.reviewSummary.issues);
            const emoji = score >= 80 ? '✅' : score >= 60 ? '⚠️' : '❌';
            console.log(`\n${emoji} Analysis completed with score: ${score}/100`);
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
            const tableOutput = output_formatters_1.OutputFormatters.formatAsTable(result, {
                showDetails: true,
                groupByCategory: true,
                includeFiles: true,
                includeTimestamp: true,
            });
            console.log(tableOutput);
            // Show summary for table
            const tableScore = (0, reviewer_1.calculateOverallScore)(result.reviewSummary.issues);
            const tableTotalIssues = (0, reviewer_1.calculateTotalIssues)(result.reviewSummary.issues);
            const tableCriticalIssues = (0, reviewer_1.calculateCriticalIssues)(result.reviewSummary.issues);
            const tableEmoji = tableScore >= 80 ? '✅' : tableScore >= 60 ? '⚠️' : '❌';
            console.log(`\n${tableEmoji} Analysis completed with score: ${tableScore}/100`);
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
//# sourceMappingURL=cli-main.js.map