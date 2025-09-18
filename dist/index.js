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
            await handleVisorMode(cliBridge, inputs, context, octokit);
            return;
        }
        // Default behavior: Use Visor config to determine what to run
        console.log('🤖 Using config-driven mode');
        // Load config to determine which checks should run for this event
        const configManager = new config_1.ConfigManager();
        let config;
        try {
            config = await configManager.findAndLoadConfig();
            console.log('📋 Loaded Visor config');
        }
        catch {
            // Use default config if none found
            config = {
                version: '1.0',
                checks: {},
                output: {
                    pr_comment: {
                        format: 'markdown',
                        group_by: 'check',
                        collapse: false,
                    },
                },
            };
            console.log('📋 Using default configuration');
        }
        // Determine which event we're handling and run appropriate checks
        await handleEvent(octokit, inputs, eventName, context, config);
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
 * Handle events based on config
 */
async function handleEvent(octokit, inputs, eventName, context, config) {
    const owner = inputs.owner;
    const repo = inputs.repo;
    if (!owner || !repo) {
        throw new Error('Owner and repo are required');
    }
    console.log(`Event: ${eventName}, Owner: ${owner}, Repo: ${repo}`);
    // Map GitHub event to our event trigger format
    const eventType = mapGitHubEventToTrigger(eventName, context.event?.action);
    // Find checks that should run for this event
    const checksToRun = [];
    for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
        // Check if this check should run for this event
        const checkEvents = checkConfig.on || ['pr_opened', 'pr_updated'];
        if (checkEvents.includes(eventType)) {
            checksToRun.push(checkName);
        }
    }
    if (checksToRun.length === 0) {
        console.log(`ℹ️ No checks configured to run for event: ${eventType}`);
        return;
    }
    console.log(`🔧 Checks to run for ${eventType}: ${checksToRun.join(', ')}`);
    // Handle different GitHub events
    switch (eventName) {
        case 'issue_comment':
            await handleIssueComment(octokit, owner, repo);
            break;
        case 'pull_request':
            // Run the checks that are configured for this event
            await handlePullRequestWithConfig(octokit, owner, repo, inputs, config, checksToRun);
            break;
        case 'push':
            // Could handle push events that are associated with PRs
            console.log('Push event detected - checking for associated PR');
            break;
        default:
            // Fallback to repo info for unknown events
            console.log(`Unknown event: ${eventName}`);
            await handleRepoInfo(octokit, owner, repo);
            break;
    }
}
/**
 * Recursively resolve dependencies for a set of check IDs
 */
function resolveDependencies(checkIds, config, resolved = new Set(), visiting = new Set()) {
    const result = [];
    for (const checkId of checkIds) {
        if (resolved.has(checkId)) {
            continue;
        }
        if (visiting.has(checkId)) {
            console.warn(`Circular dependency detected involving check: ${checkId}`);
            continue;
        }
        visiting.add(checkId);
        // Get dependencies for this check
        const checkConfig = config?.checks?.[checkId];
        const dependencies = checkConfig?.depends_on || [];
        // Recursively resolve dependencies first
        if (dependencies.length > 0) {
            const resolvedDeps = resolveDependencies(dependencies, config, resolved, visiting);
            result.push(...resolvedDeps.filter(dep => !result.includes(dep)));
        }
        // Add the current check if not already added
        if (!result.includes(checkId)) {
            result.push(checkId);
        }
        resolved.add(checkId);
        visiting.delete(checkId);
    }
    return result;
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
        config = undefined;
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
                const initialCheckIds = commandRegistry[command.type];
                // Resolve all dependencies recursively
                const checkIds = resolveDependencies(initialCheckIds, config);
                console.log(`Running checks for command /${command.type} (initial: ${initialCheckIds.join(', ')}, resolved: ${checkIds.join(', ')})`);
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
async function handlePullRequestWithConfig(octokit, owner, repo, inputs, config, checksToRun) {
    const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
    const pullRequest = context.event?.pull_request;
    const action = context.event?.action;
    if (!pullRequest) {
        console.log('No pull request found in context');
        return;
    }
    console.log(`Reviewing PR #${pullRequest.number} with checks: ${checksToRun.join(', ')}`);
    const prNumber = pullRequest.number;
    const analyzer = new pr_analyzer_1.PRAnalyzer(octokit);
    const reviewer = new reviewer_1.PRReviewer(octokit);
    // Generate comment ID for this PR
    const commentId = `pr-review-${prNumber}`;
    // Map the action to event type
    const eventType = mapGitHubEventToTrigger('pull_request', action);
    // Fetch PR diff
    const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    if (prInfo.files.length === 0) {
        console.log('⚠️ No files changed in this PR - skipping review');
        (0, core_1.setOutput)('review-completed', 'true');
        (0, core_1.setOutput)('issues-found', '0');
        return;
    }
    // Filter checks based on conditions
    const checksToExecute = await filterChecksToExecute(checksToRun, config, prInfo);
    if (checksToExecute.length === 0) {
        console.log('⚠️ No checks meet execution conditions');
        (0, core_1.setOutput)('review-completed', 'true');
        (0, core_1.setOutput)('issues-found', '0');
        return;
    }
    console.log(`📋 Executing checks: ${checksToExecute.join(', ')}`);
    // Create review options
    const reviewOptions = {
        debug: inputs?.debug === 'true',
        config: config,
        checks: checksToExecute,
        parallelExecution: true,
    };
    // Create GitHub check runs if enabled
    let checkResults = null;
    if (inputs && inputs['create-check'] !== 'false') {
        checkResults = await createGitHubChecks(octokit, inputs, owner, repo, pullRequest.head?.sha || 'unknown', checksToExecute, config);
        if (checkResults?.checkRunMap) {
            await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);
        }
    }
    // Perform the review
    const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);
    // Complete GitHub check runs
    if (checkResults?.checkRunMap) {
        await completeGitHubChecks(octokit, owner, repo, checkResults.checkRunMap, groupedResults, config);
    }
    // Post review comment
    await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
        commentId,
        triggeredBy: action,
        commitSha: pullRequest.head?.sha,
    });
    // Set outputs
    (0, core_1.setOutput)('review-completed', 'true');
    (0, core_1.setOutput)('checks-executed', checksToExecute.length.toString());
    (0, core_1.setOutput)('pr-action', action);
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
 * Filter checks based on their if conditions and API requirements
 */
async function filterChecksToExecute(checksToRun, config, prInfo) {
    const filteredChecks = [];
    // Create a basic context for condition evaluation
    const context = {
        files: prInfo?.files || [],
        filesChanged: prInfo?.files.map(f => f.filename) || [],
        event: 'pull_request',
        environment: process.env,
        metadata: {
            filesCount: prInfo?.files.length || 0,
            additions: prInfo?.totalAdditions || 0,
            deletions: prInfo?.totalDeletions || 0,
        },
    };
    for (const checkName of checksToRun) {
        const checkConfig = config?.checks?.[checkName];
        if (!checkConfig) {
            // If no config, include the check by default
            filteredChecks.push(checkName);
            continue;
        }
        // Check if the check has an if condition
        if (checkConfig.if) {
            try {
                // Import the failure condition evaluator
                const { FailureConditionEvaluator } = await Promise.resolve().then(() => __importStar(require('./failure-condition-evaluator')));
                const evaluator = new FailureConditionEvaluator();
                const shouldRun = await evaluator.evaluateIfCondition(checkName, checkConfig.if, context);
                if (shouldRun) {
                    filteredChecks.push(checkName);
                }
                else {
                    console.log(`⚠️ Skipping check '${checkName}' - if condition not met`);
                }
            }
            catch (error) {
                console.warn(`Warning: Could not evaluate if condition for ${checkName}:`, error);
                // Include the check if we can't evaluate the condition
                filteredChecks.push(checkName);
            }
        }
        else {
            // No condition, include the check
            filteredChecks.push(checkName);
        }
    }
    return filteredChecks;
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
 * Complete individual GitHub check runs
 */
async function completeIndividualChecks(checkService, owner, repo, checkRunMap, groupedResults, config) {
    // Create failure condition evaluator
    const { FailureConditionEvaluator } = await Promise.resolve().then(() => __importStar(require('./failure-condition-evaluator')));
    const failureEvaluator = new FailureConditionEvaluator();
    // Extract all issues once and group by check name for O(N) complexity
    const allIssues = extractIssuesFromGroupedResults(groupedResults);
    const issuesByCheck = new Map();
    // Initialize empty arrays for all checks
    for (const checkName of checkRunMap.keys()) {
        issuesByCheck.set(checkName, []);
    }
    // Group issues by check name
    for (const issue of allIssues) {
        const checkName = issue.ruleId?.split('/')[0];
        if (checkName && issuesByCheck.has(checkName)) {
            issuesByCheck.get(checkName).push(issue);
        }
    }
    for (const [checkName, checkRun] of checkRunMap) {
        try {
            // Get pre-grouped issues for this check - O(1) lookup
            const checkIssues = issuesByCheck.get(checkName) || [];
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
if (require.main === module) {
    run();
}
//# sourceMappingURL=index.js.map