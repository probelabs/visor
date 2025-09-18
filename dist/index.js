"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = run;
const rest_1 = require("@octokit/rest");
const auth_app_1 = require("@octokit/auth-app");
const core_1 = require("@actions/core");
const commands_1 = require("./commands");
const pr_analyzer_1 = require("./pr-analyzer");
const reviewer_1 = require("./reviewer");
const action_cli_bridge_1 = require("./action-cli-bridge");
const config_1 = require("./config");
const pr_detector_1 = require("./pr-detector");
const github_check_service_1 = require("./github-check-service");
/**
 * Create an authenticated Octokit instance using either GitHub App or token authentication
 */
async function createAuthenticatedOctokit() {
    const token = (0, core_1.getInput)('github-token');
    const appId = (0, core_1.getInput)('app-id');
    const privateKey = (0, core_1.getInput)('private-key');
    const installationId = (0, core_1.getInput)('installation-id');
    // Prefer GitHub App authentication if app credentials are provided
    if (appId && privateKey) {
        console.log('🔐 Using GitHub App authentication');
        try {
            // Note: createAppAuth is used in the Octokit constructor below
            // If no installation ID provided, try to get it for the current repository
            let finalInstallationId;
            // Validate and parse the installation ID if provided
            if (installationId) {
                finalInstallationId = parseInt(installationId, 10);
                if (isNaN(finalInstallationId) || finalInstallationId <= 0) {
                    throw new Error('Invalid installation-id provided. It must be a positive integer.');
                }
            }
            if (!finalInstallationId) {
                const owner = (0, core_1.getInput)('owner') || process.env.GITHUB_REPOSITORY_OWNER;
                const repo = (0, core_1.getInput)('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1];
                if (owner && repo) {
                    // Create a temporary JWT-authenticated client to find the installation
                    const appOctokit = new rest_1.Octokit({
                        authStrategy: auth_app_1.createAppAuth,
                        auth: {
                            appId,
                            privateKey,
                        },
                    });
                    try {
                        const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({
                            owner,
                            repo,
                        });
                        finalInstallationId = installation.id;
                        console.log(`✅ Auto-detected installation ID: ${finalInstallationId}`);
                    }
                    catch {
                        console.warn('⚠️ Could not auto-detect installation ID. Please check app permissions and installation status.');
                        throw new Error('GitHub App installation ID is required but could not be auto-detected. Please ensure the app is installed on this repository or provide the `installation-id` manually.');
                    }
                }
            }
            // Create the authenticated Octokit instance
            const octokit = new rest_1.Octokit({
                authStrategy: auth_app_1.createAppAuth,
                auth: {
                    appId,
                    privateKey,
                    installationId: finalInstallationId,
                },
            });
            return { octokit, authType: 'github-app' };
        }
        catch (error) {
            console.error('❌ GitHub App authentication failed. Please check your App ID, Private Key, and installation permissions.');
            throw new Error(`GitHub App authentication failed`, { cause: error });
        }
    }
    // Fall back to token authentication
    if (token) {
        console.log('🔑 Using GitHub token authentication');
        return {
            octokit: new rest_1.Octokit({ auth: token }),
            authType: 'token',
        };
    }
    throw new Error('Either github-token or app-id/private-key must be provided for authentication');
}
async function run() {
    try {
        const { octokit, authType } = await createAuthenticatedOctokit();
        console.log(`✅ Authenticated successfully using ${authType}`);
        // Get token for passing to CLI bridge (might be undefined if using App auth)
        const token = (0, core_1.getInput)('github-token') || '';
        // Collect all GitHub Action inputs
        const inputs = {
            'github-token': token,
            owner: (0, core_1.getInput)('owner') || process.env.GITHUB_REPOSITORY_OWNER,
            repo: (0, core_1.getInput)('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1],
            'auto-review': (0, core_1.getInput)('auto-review'),
            debug: (0, core_1.getInput)('debug'),
            // GitHub App authentication inputs
            'app-id': (0, core_1.getInput)('app-id') || undefined,
            'private-key': (0, core_1.getInput)('private-key') || undefined,
            'installation-id': (0, core_1.getInput)('installation-id') || undefined,
            // Only collect other inputs if they have values to avoid triggering CLI mode
            checks: (0, core_1.getInput)('checks') || undefined,
            'output-format': (0, core_1.getInput)('output-format') || undefined,
            'config-path': (0, core_1.getInput)('config-path') || undefined,
            'comment-on-pr': (0, core_1.getInput)('comment-on-pr') || undefined,
            'create-check': (0, core_1.getInput)('create-check') || undefined,
            'add-labels': (0, core_1.getInput)('add-labels') || undefined,
            'fail-on-critical': (0, core_1.getInput)('fail-on-critical') || undefined,
            'fail-on-api-error': (0, core_1.getInput)('fail-on-api-error') || undefined,
            'min-score': (0, core_1.getInput)('min-score') || undefined,
            'max-parallelism': (0, core_1.getInput)('max-parallelism') || undefined,
            // Legacy inputs for backward compatibility
            'visor-config-path': (0, core_1.getInput)('visor-config-path') || undefined,
            'visor-checks': (0, core_1.getInput)('visor-checks') || undefined,
        };
        const eventName = process.env.GITHUB_EVENT_NAME;
        const autoReview = inputs['auto-review'] === 'true';
        // Create GitHub context for CLI bridge
        const context = {
            event_name: eventName || 'unknown',
            repository: process.env.GITHUB_REPOSITORY
                ? {
                    owner: { login: process.env.GITHUB_REPOSITORY.split('/')[0] },
                    name: process.env.GITHUB_REPOSITORY.split('/')[1],
                }
                : undefined,
            event: process.env.GITHUB_CONTEXT ? JSON.parse(process.env.GITHUB_CONTEXT).event : {},
            payload: process.env.GITHUB_CONTEXT ? JSON.parse(process.env.GITHUB_CONTEXT) : {},
        };
        // Initialize CLI bridge
        const cliBridge = new action_cli_bridge_1.ActionCliBridge(token, context);
        // Check if we should use Visor CLI
        console.log('Debug: inputs.debug =', inputs.debug);
        console.log('Debug: inputs.checks =', inputs.checks);
        console.log('Debug: inputs.config-path =', inputs['config-path']);
        console.log('Debug: inputs.visor-checks =', inputs['visor-checks']);
        console.log('Debug: inputs.visor-config-path =', inputs['visor-config-path']);
        if (cliBridge.shouldUseVisor(inputs)) {
            console.log('🔍 Using Visor CLI mode');
            // ENHANCED FIX: For PR auto-reviews, detect PR context across all event types
            const isAutoReview = inputs['auto-review'] === 'true';
            if (isAutoReview) {
                console.log('🔄 Auto-review enabled - attempting to detect PR context across all event types');
                // Try to detect if we're in a PR context (works for push, pull_request, issue_comment, etc.)
                const prDetected = await detectPRContext(inputs, context, octokit);
                if (prDetected) {
                    console.log('✅ PR context detected - using GitHub API for PR analysis');
                    await handlePullRequestVisorMode(inputs, context, octokit, authType);
                    return;
                }
                else {
                    console.log('ℹ️ No PR context detected - proceeding with CLI mode for general analysis');
                }
            }
            await handleVisorMode(cliBridge, inputs, context, octokit);
            return;
        }
        console.log('🤖 Using legacy GitHub Action mode');
        await handleLegacyMode(octokit, inputs, eventName, autoReview);
    }
    catch (error) {
        (0, core_1.setFailed)(error instanceof Error ? error.message : 'Unknown error');
    }
}
/**
 * Handle Visor CLI mode
 */
async function handleVisorMode(cliBridge, inputs, _context, _octokit) {
    try {
        // Note: PR auto-review cases are now handled upstream in the main run() function
        // Execute CLI with the provided config file (no temp config creation)
        const result = await cliBridge.executeCliWithContext(inputs);
        if (result.success) {
            console.log('✅ Visor CLI execution completed successfully');
            // Parse JSON output for PR comment creation
            let cliOutput;
            try {
                // Extract JSON from CLI output
                const outputLines = result.output?.split('\n') || [];
                const jsonLine = outputLines.find(line => line.trim().startsWith('{') && line.trim().endsWith('}'));
                if (jsonLine) {
                    cliOutput = JSON.parse(jsonLine);
                    console.log('📊 CLI Review Results:', cliOutput);
                    // Note: PR comment posting is now handled by handlePullRequestVisorMode for PR events
                    // CLI mode output is intended for non-PR scenarios
                }
                else {
                    console.log('📄 CLI Output (non-JSON):', result.output);
                }
            }
            catch (parseError) {
                console.log('⚠️ Could not parse CLI output as JSON:', parseError);
                console.log('📄 Raw CLI Output:', result.output);
            }
            // Set outputs based on CLI result
            const outputs = cliBridge.mergeActionAndCliOutputs(inputs, result);
            // Add additional outputs from parsed JSON
            if (cliOutput) {
                outputs['total-issues'] = cliOutput.totalIssues?.toString() || '0';
                outputs['critical-issues'] = cliOutput.criticalIssues?.toString() || '0';
            }
            for (const [key, value] of Object.entries(outputs)) {
                (0, core_1.setOutput)(key, value);
            }
        }
        else {
            console.error('❌ Visor CLI execution failed');
            console.error(result.error || result.output);
            (0, core_1.setFailed)(result.error || 'CLI execution failed');
        }
    }
    catch (error) {
        console.error('❌ Visor mode error:', error);
        (0, core_1.setFailed)(error instanceof Error ? error.message : 'Visor mode failed');
    }
}
function mapGitHubEventToTrigger(eventName, action) {
    if (!eventName)
        return 'pr_updated';
    switch (eventName) {
        case 'pull_request':
            if (action === 'opened')
                return 'pr_opened';
            if (action === 'synchronize' || action === 'edited')
                return 'pr_updated';
            return 'pr_updated';
        case 'issues':
            if (action === 'opened')
                return 'issue_opened';
            return 'issue_opened';
        case 'issue_comment':
            return 'issue_comment';
        default:
            return 'pr_updated';
    }
}
/**
 * Handle legacy GitHub Action mode (backward compatibility)
 */
async function handleLegacyMode(octokit, inputs, eventName, autoReview) {
    const owner = inputs.owner;
    const repo = inputs.repo;
    if (!owner || !repo) {
        throw new Error('Owner and repo are required');
    }
    console.log(`Event: ${eventName}, Owner: ${owner}, Repo: ${repo}`);
    // Handle different GitHub events
    switch (eventName) {
        case 'issue_comment':
            await handleIssueComment(octokit, owner, repo);
            break;
        case 'pull_request':
            if (autoReview) {
                await handlePullRequestEvent(octokit, owner, repo, inputs);
            }
            break;
        default:
            // Fallback to original repo info functionality
            await handleRepoInfo(octokit, owner, repo);
            break;
    }
}
async function handleIssueComment(octokit, owner, repo) {
    const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
    const comment = context.event?.comment;
    const issue = context.event?.issue;
    if (!comment || !issue) {
        console.log('No comment or issue found in context');
        return;
    }
    // Prevent recursion: skip if comment is from visor itself
    if (comment.body &&
        (comment.body.includes('<!-- visor-comment-id:') ||
            comment.body.includes('*Powered by [Visor]'))) {
        console.log('Skipping visor comment to prevent recursion');
        return;
    }
    // Process comments on both issues and PRs
    // (issue.pull_request exists for PR comments, doesn't exist for issue comments)
    // Load configuration to get available commands
    const configManager = new config_1.ConfigManager();
    let config;
    const commandRegistry = {};
    try {
        config = await configManager.findAndLoadConfig();
        // Build command registry from config
        if (config.checks) {
            // Add 'review' command that runs all checks
            commandRegistry['review'] = Object.keys(config.checks);
            // Also add individual check names as commands
            for (const [checkId, checkConfig] of Object.entries(config.checks)) {
                // Legacy: check if it has old 'command' property
                if (checkConfig.command) {
                    if (!commandRegistry[checkConfig.command]) {
                        commandRegistry[checkConfig.command] = [];
                    }
                    commandRegistry[checkConfig.command].push(checkId);
                }
                // New: add check name as command
                commandRegistry[checkId] = [checkId];
            }
        }
    }
    catch {
        console.log('Could not load config, using defaults');
        config = null;
        // Default commands when no config is available
        commandRegistry['review'] = ['security', 'performance', 'style', 'architecture'];
    }
    // Parse comment with available commands
    const availableCommands = Object.keys(commandRegistry);
    const command = (0, commands_1.parseComment)(comment.body, availableCommands);
    if (!command) {
        console.log('No valid command found in comment');
        return;
    }
    console.log(`Processing command: ${command.type}`);
    const prNumber = issue.number;
    const analyzer = new pr_analyzer_1.PRAnalyzer(octokit);
    const reviewer = new reviewer_1.PRReviewer(octokit);
    switch (command.type) {
        case 'status':
            const statusPrInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, 'issue_comment');
            const statusComment = `## 📊 PR Status\n\n` +
                `**Title:** ${statusPrInfo.title}\n` +
                `**Author:** ${statusPrInfo.author}\n` +
                `**Files Changed:** ${statusPrInfo.files.length}\n` +
                `**Additions:** +${statusPrInfo.totalAdditions}\n` +
                `**Deletions:** -${statusPrInfo.totalDeletions}\n` +
                `**Base:** ${statusPrInfo.base} → **Head:** ${statusPrInfo.head}\n\n` +
                `---\n` +
                `*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: prNumber,
                body: statusComment,
            });
            break;
        case 'help':
            await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: prNumber,
                body: (0, commands_1.getHelpText)(commandRegistry),
            });
            break;
        default:
            // Handle custom commands from config
            if (commandRegistry[command.type]) {
                const checkIds = commandRegistry[command.type];
                console.log(`Running checks for command /${command.type}: ${checkIds.join(', ')}`);
                const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, 'issue_comment');
                // Extract common arguments
                const focus = command.args?.find(arg => arg.startsWith('--focus='))?.split('=')[1];
                const format = command.args?.find(arg => arg.startsWith('--format='))?.split('=')[1];
                // If focus is specified, update the checks' focus
                if (focus && config?.checks) {
                    for (const checkId of checkIds) {
                        if (config.checks[checkId]) {
                            config.checks[checkId].focus = focus;
                        }
                    }
                }
                const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, {
                    focus,
                    format,
                    config: config,
                    checks: checkIds,
                    parallelExecution: false,
                });
                await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
                    focus,
                    format,
                });
                // Calculate total check results from grouped results
                const totalChecks = Object.values(groupedResults).flat().length;
                (0, core_1.setOutput)('checks-executed', totalChecks.toString());
            }
            break;
    }
}
async function handlePullRequestEvent(octokit, owner, repo, inputs) {
    const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
    const pullRequest = context.event?.pull_request;
    const action = context.event?.action;
    if (!pullRequest) {
        console.log('No pull request found in context');
        return;
    }
    // Handle multiple PR actions: opened, synchronize, edited
    const supportedActions = ['opened', 'synchronize', 'edited'];
    if (!supportedActions.includes(action)) {
        console.log(`Unsupported PR action: ${action}. Supported actions: ${supportedActions.join(', ')}`);
        return;
    }
    console.log(`Auto-reviewing PR #${pullRequest.number} (action: ${action})`);
    const prNumber = pullRequest.number;
    const analyzer = new pr_analyzer_1.PRAnalyzer(octokit);
    const reviewer = new reviewer_1.PRReviewer(octokit);
    // Generate comment ID for this PR to enable smart updating
    const commentId = `pr-review-${prNumber}`;
    let prInfo;
    // Map the action to event type
    const eventType = mapGitHubEventToTrigger('pull_request', action);
    // For synchronize (new commits), get the latest commit SHA for incremental analysis
    if (action === 'synchronize') {
        const latestCommitSha = pullRequest.head?.sha;
        if (latestCommitSha) {
            console.log(`Analyzing incremental changes from commit: ${latestCommitSha}`);
            prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, latestCommitSha, eventType);
        }
        else {
            // Fallback to full analysis if no commit SHA available
            prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
        }
    }
    else {
        // For opened and edited events, do full PR analysis
        prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    }
    // Load config for the review
    const configManager = new config_1.ConfigManager();
    let config;
    try {
        config = await configManager.findAndLoadConfig();
    }
    catch {
        // Fall back to a basic configuration for PR auto-review
        config = {
            version: '1.0',
            output: {
                pr_comment: {
                    format: 'markdown',
                    group_by: 'check',
                    collapse: false,
                },
            },
            checks: {
                'auto-review': {
                    type: 'ai',
                    on: ['pr_opened', 'pr_updated'],
                    prompt: `Review this pull request comprehensively. Look for security issues, performance problems, code quality, bugs, and suggest improvements. Action: ${action}`,
                },
            },
        };
    }
    // Create review options, including debug if enabled
    const reviewOptions = {
        debug: inputs?.debug === 'true',
        config: config,
        checks: ['auto-review'],
        parallelExecution: false,
    };
    // Create GitHub check runs for legacy auto-review
    let checkResults = null;
    if (inputs && inputs['github-token']) {
        checkResults = await createGitHubChecks(octokit, inputs, owner, repo, pullRequest.head?.sha || 'unknown', ['auto-review'], config);
    }
    // Update checks to in-progress status
    if (checkResults) {
        await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);
    }
    // Perform the review with debug options
    const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);
    // Complete GitHub check runs with results
    if (checkResults) {
        await completeGitHubChecks(octokit, owner, repo, checkResults.checkRunMap, groupedResults, config);
    }
    // If debug mode is enabled, output debug information to console
    const firstDebugInfo = Object.values(groupedResults).flat()[0]?.debug;
    if (reviewOptions.debug && firstDebugInfo) {
        console.log('\n========================================');
        console.log('🐛 DEBUG INFORMATION');
        console.log('========================================');
        console.log(`Provider: ${firstDebugInfo.provider}`);
        console.log(`Model: ${firstDebugInfo.model}`);
        console.log(`API Key Source: ${firstDebugInfo.apiKeySource}`);
        console.log(`Processing Time: ${firstDebugInfo.processingTime}ms`);
        console.log(`Prompt Length: ${firstDebugInfo.promptLength} characters`);
        console.log(`Response Length: ${firstDebugInfo.responseLength} characters`);
        console.log(`JSON Parse Success: ${firstDebugInfo.jsonParseSuccess ? '✅' : '❌'}`);
        if (firstDebugInfo.errors && firstDebugInfo.errors.length > 0) {
            console.log(`\n⚠️ Errors:`);
            firstDebugInfo.errors.forEach(err => console.log(`  - ${err}`));
        }
        console.log('\n--- AI PROMPT ---');
        console.log(firstDebugInfo.prompt.substring(0, 500) + '...');
        console.log('\n--- RAW RESPONSE ---');
        console.log(firstDebugInfo.rawResponse.substring(0, 500) + '...');
        console.log('========================================\n');
    }
    // Post the actual review results using the reviewer's comment formatting
    try {
        await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
            commentId,
            triggeredBy: action,
            commitSha: pullRequest.head?.sha,
        });
        console.log(`✅ ${action === 'opened' ? 'Created' : 'Updated'} PR review comment with actual results`);
    }
    catch (commentError) {
        // Don't fail the action if comment posting fails - we already have the results
        console.warn(`⚠️  Failed to post/update comment: ${commentError}`);
    }
    // Set outputs
    (0, core_1.setOutput)('auto-review-completed', 'true');
    (0, core_1.setOutput)('checks-executed', Object.values(groupedResults).flat().length.toString());
    (0, core_1.setOutput)('pr-action', action);
    (0, core_1.setOutput)('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
    // Set GitHub check run outputs
    (0, core_1.setOutput)('checks-api-available', checkResults?.checksApiAvailable.toString() || 'false');
    (0, core_1.setOutput)('check-runs-created', checkResults?.checkRunsCreated.toString() || '0');
    (0, core_1.setOutput)('check-runs-urls', checkResults?.checkRunUrls.join(',') || '');
}
async function handleRepoInfo(octokit, owner, repo) {
    const { data: repoData } = await octokit.rest.repos.get({
        owner,
        repo,
    });
    (0, core_1.setOutput)('repo-name', repoData.name);
    (0, core_1.setOutput)('repo-description', repoData.description || '');
    (0, core_1.setOutput)('repo-stars', repoData.stargazers_count.toString());
    console.log(`Repository: ${repoData.full_name}`);
    console.log(`Description: ${repoData.description || 'No description'}`);
    console.log(`Stars: ${repoData.stargazers_count}`);
}
/**
 * Create GitHub check runs for individual checks if enabled
 */
async function createGitHubChecks(octokit, inputs, owner, repo, headSha, checksToRun, config) {
    // Check if GitHub checks are enabled via input (default is true)
    const createCheckInput = inputs['create-check'] !== 'false';
    // Check if GitHub checks are enabled via config (default is true if not specified)
    const createCheckConfig = config?.output?.github_checks?.enabled !== false;
    if (!createCheckInput || !createCheckConfig) {
        const reason = !createCheckInput ? 'create-check input' : 'configuration';
        console.log(`🔧 GitHub check runs disabled via ${reason}`);
        return {
            checkRunMap: null,
            checksApiAvailable: true,
            checkRunsCreated: 0,
            checkRunUrls: [],
        };
    }
    // Check if per-check mode is enabled (default is true)
    const perCheckMode = config?.output?.github_checks?.per_check !== false;
    try {
        const checkService = new github_check_service_1.GitHubCheckService(octokit);
        const checkRunMap = new Map();
        const checkRunUrls = [];
        // Get custom name prefix if specified
        const namePrefix = config?.output?.github_checks?.name_prefix || 'Visor';
        if (perCheckMode) {
            console.log(`🔍 Creating individual GitHub check runs for ${checksToRun.length} checks...`);
            // Create individual check runs for each configured check
            for (const checkName of checksToRun) {
                try {
                    const checkRunOptions = {
                        owner,
                        repo,
                        head_sha: headSha,
                        name: `${namePrefix}: ${checkName}`,
                        external_id: `visor-${checkName}-${headSha.substring(0, 7)}`,
                    };
                    const checkRun = await checkService.createCheckRun(checkRunOptions, {
                        title: `${checkName} Analysis`,
                        summary: `Running ${checkName} check using AI-powered analysis...`,
                    });
                    checkRunMap.set(checkName, checkRun);
                    checkRunUrls.push(checkRun.url);
                    console.log(`✅ Created check run for ${checkName}: ${checkRun.url}`);
                }
                catch (error) {
                    console.error(`❌ Failed to create check run for ${checkName}:`, error);
                    // Continue with other checks even if one fails
                }
            }
        }
        else {
            // Create a single check run for all checks
            console.log(`🔍 Creating single GitHub check run for ${checksToRun.length} checks...`);
            try {
                const checkRunOptions = {
                    owner,
                    repo,
                    head_sha: headSha,
                    name: `${namePrefix}: Code Review`,
                    external_id: `visor-combined-${headSha.substring(0, 7)}`,
                };
                const checkRun = await checkService.createCheckRun(checkRunOptions, {
                    title: 'AI Code Review',
                    summary: `Running ${checksToRun.join(', ')} checks using AI-powered analysis...`,
                });
                // Use 'combined' as the key for all checks
                checkRunMap.set('combined', checkRun);
                checkRunUrls.push(checkRun.url);
                console.log(`✅ Created combined check run: ${checkRun.url}`);
            }
            catch (error) {
                console.error(`❌ Failed to create combined check run:`, error);
            }
        }
        return {
            checkRunMap,
            checksApiAvailable: true,
            checkRunsCreated: checkRunMap.size,
            checkRunUrls,
        };
    }
    catch (error) {
        // Check if this is a permissions error
        if (error instanceof Error &&
            (error.message.includes('403') || error.message.includes('checks:write'))) {
            console.warn('⚠️ GitHub checks API not available - insufficient permissions. Check runs will be skipped.');
            console.warn('💡 To enable check runs, ensure your GitHub token has "checks:write" permission.');
            return {
                checkRunMap: null,
                checksApiAvailable: false,
                checkRunsCreated: 0,
                checkRunUrls: [],
            };
        }
        else {
            console.error('❌ Failed to create GitHub check runs:', error);
            return {
                checkRunMap: null,
                checksApiAvailable: false,
                checkRunsCreated: 0,
                checkRunUrls: [],
            };
        }
    }
}
/**
 * Update GitHub check runs to in-progress status
 */
async function updateChecksInProgress(octokit, owner, repo, checkRunMap) {
    if (!checkRunMap)
        return;
    const checkService = new github_check_service_1.GitHubCheckService(octokit);
    for (const [checkName, checkRun] of checkRunMap) {
        try {
            await checkService.updateCheckRunInProgress(owner, repo, checkRun.id, {
                title: `Analyzing with ${checkName}...`,
                summary: `AI-powered analysis is in progress for ${checkName} check.`,
            });
            console.log(`🔄 Updated ${checkName} check to in-progress status`);
        }
        catch (error) {
            console.error(`❌ Failed to update ${checkName} check to in-progress:`, error);
        }
    }
}
/**
 * Complete GitHub check runs with results
 */
async function completeGitHubChecks(octokit, owner, repo, checkRunMap, groupedResults, config) {
    if (!checkRunMap)
        return;
    const checkService = new github_check_service_1.GitHubCheckService(octokit);
    const perCheckMode = config?.output?.github_checks?.per_check !== false;
    console.log(`🏁 Completing ${checkRunMap.size} GitHub check runs...`);
    if (perCheckMode && !checkRunMap.has('combined')) {
        // Per-check mode: complete individual check runs
        await completeIndividualChecks(checkService, owner, repo, checkRunMap, groupedResults, config);
    }
    else {
        // Combined mode: complete single check run with all results
        await completeCombinedCheck(checkService, owner, repo, checkRunMap, groupedResults, config);
    }
}
/**
 * Extract ReviewIssue[] from GroupedCheckResults content by parsing the rendered text
 * This function parses the structured content created by CheckExecutionEngine.convertReviewSummaryToGroupedResults()
 */
function extractIssuesFromGroupedResults(groupedResults) {
    const issues = [];
    for (const [groupName, checkResults] of Object.entries(groupedResults)) {
        for (const checkResult of checkResults) {
            const { checkName, content } = checkResult;
            // First, check if structured issues are available
            if (checkResult.issues && checkResult.issues.length > 0) {
                // Use structured issues directly - they're already properly formatted
                issues.push(...checkResult.issues);
                continue;
            }
            // Fall back to parsing issues from content (legacy support)
            // Parse issues from content - look for lines like:
            // - **CRITICAL**: message (file:line)
            // - **ERROR**: message (file:line)
            // - **WARNING**: message (file:line)
            // - **INFO**: message (file:line)
            const issueRegex = /^- \*\*([A-Z]+)\*\*: (.+?) \(([^:]+):(\d+)\)$/gm;
            let match;
            while ((match = issueRegex.exec(content)) !== null) {
                const [, severityUpper, message, file, lineStr] = match;
                const severity = severityUpper.toLowerCase();
                const line = parseInt(lineStr, 10);
                // Create ReviewIssue with proper format for GitHub annotations
                const issue = {
                    file,
                    line,
                    ruleId: `${checkName}/content-parsed`,
                    message: message.trim(),
                    severity,
                    category: 'logic', // Default category since we can't parse this from content
                    group: groupName,
                    timestamp: Date.now(),
                };
                issues.push(issue);
            }
        }
    }
    return issues;
}
/**
 * Extract issues for a specific check from GroupedCheckResults
 */
function extractIssuesForCheck(groupedResults, checkName) {
    const allIssues = extractIssuesFromGroupedResults(groupedResults);
    return allIssues.filter(issue => issue.ruleId?.startsWith(`${checkName}/`));
}
/**
 * Complete individual GitHub check runs
 */
async function completeIndividualChecks(checkService, owner, repo, checkRunMap, groupedResults, config) {
    // Create failure condition evaluator
    const { FailureConditionEvaluator } = await Promise.resolve().then(() => __importStar(require('./failure-condition-evaluator')));
    const failureEvaluator = new FailureConditionEvaluator();
    for (const [checkName, checkRun] of checkRunMap) {
        try {
            // Extract issues for this specific check from the grouped results content
            const checkIssues = extractIssuesForCheck(groupedResults, checkName);
            // Evaluate failure conditions based on fail_if configuration
            const failureResults = [];
            // Get global and check-specific fail_if conditions
            const globalFailIf = config?.fail_if;
            const checkFailIf = config?.checks?.[checkName]?.fail_if;
            // Create a ReviewSummary for this check's issues
            const checkReviewSummary = {
                issues: checkIssues,
                suggestions: [],
            };
            // Determine which fail_if to use: check-specific overrides global
            const effectiveFailIf = checkFailIf || globalFailIf;
            if (effectiveFailIf) {
                const failed = await failureEvaluator.evaluateSimpleCondition(checkName, config?.checks?.[checkName]?.schema || 'plain', config?.checks?.[checkName]?.group || 'default', checkReviewSummary, effectiveFailIf);
                if (failed) {
                    const isCheckSpecific = checkFailIf !== undefined;
                    failureResults.push({
                        conditionName: isCheckSpecific ? `${checkName}_fail_if` : 'global_fail_if',
                        expression: effectiveFailIf,
                        failed: true,
                        severity: 'error',
                        message: isCheckSpecific
                            ? `Check ${checkName} failure condition met`
                            : 'Global failure condition met',
                        haltExecution: false,
                    });
                }
            }
            await checkService.completeCheckRun(owner, repo, checkRun.id, checkName, failureResults, checkIssues // Pass extracted issues for GitHub annotations
            );
            console.log(`✅ Completed ${checkName} check with ${checkIssues.length} issues, ${failureResults.length} failure conditions evaluated`);
        }
        catch (error) {
            console.error(`❌ Failed to complete ${checkName} check:`, error);
            await markCheckAsFailed(checkService, owner, repo, checkRun.id, checkName, error);
        }
    }
}
/**
 * Complete combined GitHub check run
 */
async function completeCombinedCheck(checkService, owner, repo, checkRunMap, groupedResults, config) {
    const combinedCheckRun = checkRunMap.get('combined');
    if (!combinedCheckRun)
        return;
    // Create failure condition evaluator
    const { FailureConditionEvaluator } = await Promise.resolve().then(() => __importStar(require('./failure-condition-evaluator')));
    const failureEvaluator = new FailureConditionEvaluator();
    try {
        // Extract all issues from the grouped results for the combined check
        const allIssues = extractIssuesFromGroupedResults(groupedResults);
        // Evaluate failure conditions for combined check
        const failureResults = [];
        // Create a combined ReviewSummary with all issues
        const combinedReviewSummary = {
            issues: allIssues,
            suggestions: [],
        };
        // Evaluate global fail_if for the combined check
        const globalFailIf = config?.fail_if;
        if (globalFailIf) {
            const failed = await failureEvaluator.evaluateSimpleCondition('combined', 'plain', 'combined', combinedReviewSummary, globalFailIf);
            if (failed) {
                failureResults.push({
                    conditionName: 'global_fail_if',
                    expression: globalFailIf,
                    failed: true,
                    severity: 'error',
                    message: 'Global failure condition met',
                    haltExecution: false,
                });
            }
        }
        await checkService.completeCheckRun(owner, repo, combinedCheckRun.id, 'Code Review', failureResults, allIssues // Pass all extracted issues for GitHub annotations
        );
        console.log(`✅ Completed combined check with ${allIssues.length} issues, ${failureResults.length} failure conditions evaluated`);
    }
    catch (error) {
        console.error(`❌ Failed to complete combined check:`, error);
        await markCheckAsFailed(checkService, owner, repo, combinedCheckRun.id, 'Code Review', error);
    }
}
/**
 * Mark a check as failed due to execution error
 */
async function markCheckAsFailed(checkService, owner, repo, checkRunId, checkName, error) {
    try {
        await checkService.completeCheckRun(owner, repo, checkRunId, checkName, [], [], error instanceof Error ? error.message : 'Unknown error occurred');
    }
    catch (finalError) {
        console.error(`❌ Failed to mark ${checkName} check as failed:`, finalError);
    }
}
/**
 * Handle PR review using Visor config but with proper GitHub API PR diff analysis
 */
async function handlePullRequestVisorMode(inputs, _context, octokit, _authType) {
    const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
    const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];
    if (!owner || !repo) {
        console.error('❌ Missing required GitHub parameters for PR analysis');
        (0, core_1.setFailed)('Missing required GitHub parameters');
        return;
    }
    // Use the provided authenticated Octokit instance
    const prDetector = new pr_detector_1.PRDetector(octokit, inputs.debug === 'true');
    // Convert GitHub context to our format
    const eventContext = {
        event_name: process.env.GITHUB_EVENT_NAME || 'unknown',
        repository: {
            owner: { login: owner },
            name: repo,
        },
        event: process.env.GITHUB_CONTEXT ? JSON.parse(process.env.GITHUB_CONTEXT).event : undefined,
        payload: process.env.GITHUB_CONTEXT ? JSON.parse(process.env.GITHUB_CONTEXT) : {},
    };
    // Use robust PR detection
    const prResult = await prDetector.detectPRNumber(eventContext, owner, repo);
    const action = eventContext.event?.action;
    if (!prResult.prNumber) {
        console.error(`❌ No PR found using any detection strategy: ${prResult.details || 'Unknown reason'}`);
        if (inputs.debug === 'true') {
            console.error('Available detection strategies:');
            prDetector.getDetectionStrategies().forEach(strategy => console.error(`  ${strategy}`));
        }
        (0, core_1.setFailed)('No PR number found');
        return;
    }
    const prNumber = prResult.prNumber;
    console.log(`✅ Found PR #${prNumber} using ${prResult.source} (confidence: ${prResult.confidence})`);
    if (prResult.details) {
        console.log(`   Details: ${prResult.details}`);
    }
    console.log(`🔍 Analyzing PR #${prNumber} using Visor config (action: ${action})`);
    try {
        // Use the existing PR analysis infrastructure but with Visor config
        const analyzer = new pr_analyzer_1.PRAnalyzer(octokit);
        const reviewer = new reviewer_1.PRReviewer(octokit);
        // Load Visor config
        const configManager = new config_1.ConfigManager();
        let config;
        const configPath = inputs['config-path'];
        if (configPath) {
            try {
                config = await configManager.loadConfig(configPath);
                console.log(`📋 Loaded Visor config from: ${configPath}`);
            }
            catch (error) {
                console.error(`⚠️ Could not load config from ${configPath}:`, error);
                config = await configManager.findAndLoadConfig();
            }
        }
        else {
            // Try to find and load config from default locations (.visor.yaml)
            config = await configManager.findAndLoadConfig();
            const hasCustomConfig = config.checks && Object.keys(config.checks).length > 0;
            if (hasCustomConfig) {
                console.log(`📋 Loaded Visor config from default location (.visor.yaml)`);
            }
            else {
                console.log(`📋 Using default Visor configuration`);
            }
        }
        // Extract checks from config
        const configChecks = Object.keys(config.checks || {});
        const checksToRun = configChecks.length > 0 ? configChecks : ['security', 'performance', 'style', 'architecture'];
        console.log(`🔧 Running checks: ${checksToRun.join(', ')}`);
        // Map GitHub event name to our EventTrigger format
        const eventType = mapGitHubEventToTrigger(process.env.GITHUB_EVENT_NAME, action);
        // Fetch PR diff using GitHub API
        const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
        console.log(`📄 Found ${prInfo.files.length} changed files`);
        if (prInfo.files.length === 0) {
            console.log('⚠️ No files changed in this PR - skipping review');
            // Set basic outputs
            (0, core_1.setOutput)('auto-review-completed', 'true');
            (0, core_1.setOutput)('issues-found', '0');
            (0, core_1.setOutput)('pr-action', action || 'unknown');
            (0, core_1.setOutput)('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
            return;
        }
        // Create a custom review options with Visor config
        const reviewOptions = {
            debug: inputs.debug === 'true',
            config: config,
            checks: checksToRun,
            parallelExecution: true,
        };
        // Fetch PR info to get commit SHA for metadata
        const { data: pullRequest } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: prNumber,
        });
        // Create GitHub check runs for each configured check
        const checkResults = await createGitHubChecks(octokit, inputs, owner, repo, pullRequest.head.sha, checksToRun, config);
        // Update checks to in-progress status
        await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);
        // Perform the review
        console.log('🤖 Starting parallel AI review with Visor config...');
        const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);
        // Complete GitHub check runs with results
        if (checkResults) {
            await completeGitHubChecks(octokit, owner, repo, checkResults.checkRunMap, groupedResults, config);
        }
        // Post comment using group-based comment separation
        const commentId = `visor-config-review-${prNumber}`;
        await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
            ...reviewOptions,
            commentId,
            triggeredBy: `visor-config-${action}`,
            commitSha: pullRequest.head?.sha,
        });
        console.log('✅ Posted Visor config-based review comment');
        // Check for API errors in the review content
        const allContent = Object.values(groupedResults)
            .flat()
            .map(result => result.content)
            .join(' ');
        const hasApiErrors = allContent.includes('API rate limit') ||
            allContent.includes('403') ||
            allContent.includes('401') ||
            allContent.includes('authentication') ||
            allContent.includes('API key');
        if (hasApiErrors) {
            console.error('🚨 Critical API errors detected in review content');
            // Check if we should fail on API errors
            const failOnApiError = inputs['fail-on-api-error'] === 'true';
            if (failOnApiError) {
                (0, core_1.setFailed)('Critical API errors detected in review content. Please check your API credentials.');
                return;
            }
        }
        // Set outputs
        (0, core_1.setOutput)('auto-review-completed', 'true');
        (0, core_1.setOutput)('checks-executed', Object.values(groupedResults).flat().length.toString());
        (0, core_1.setOutput)('pr-action', action || 'unknown');
        (0, core_1.setOutput)('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
        (0, core_1.setOutput)('visor-config-used', 'true');
        (0, core_1.setOutput)('checks-run', checksToRun.join(','));
        (0, core_1.setOutput)('api-errors-found', hasApiErrors ? '1' : '0');
        // Set GitHub check run outputs
        (0, core_1.setOutput)('checks-api-available', checkResults.checksApiAvailable.toString());
        (0, core_1.setOutput)('check-runs-created', checkResults.checkRunsCreated.toString());
        (0, core_1.setOutput)('check-runs-urls', checkResults.checkRunUrls.join(','));
    }
    catch (error) {
        console.error('❌ Error in Visor PR analysis:', error);
        (0, core_1.setFailed)(error instanceof Error ? error.message : 'Visor PR analysis failed');
    }
}
/**
 * Detect if we're in a PR context for any GitHub event type
 */
async function detectPRContext(inputs, context, octokit) {
    try {
        const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
        const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];
        if (!owner || !repo) {
            return false;
        }
        // Use the provided authenticated Octokit instance
        const prDetector = new pr_detector_1.PRDetector(octokit, inputs.debug === 'true');
        // Convert GitHub context to our format
        const eventContext = {
            event_name: context.event_name,
            repository: {
                owner: { login: owner },
                name: repo,
            },
            event: context.event,
            payload: context.payload || {},
        };
        const prResult = await prDetector.detectPRNumber(eventContext, owner, repo);
        return prResult.prNumber !== null;
    }
    catch (error) {
        console.error('Error detecting PR context:', error);
        return false;
    }
}
if (require.main === module) {
    run();
}
//# sourceMappingURL=index.js.map