import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText, CommandRegistry } from './commands';
import { PRAnalyzer } from './pr-analyzer';
import { PRReviewer, GroupedCheckResults, ReviewIssue } from './reviewer';
import { ActionCliBridge, GitHubActionInputs, GitHubContext } from './action-cli-bridge';
import { ConfigManager } from './config';
import { PRDetector, GitHubEventContext } from './pr-detector';
import { GitHubCheckService, CheckRunOptions } from './github-check-service';

/**
 * Create an authenticated Octokit instance using either GitHub App or token authentication
 */
async function createAuthenticatedOctokit(): Promise<{ octokit: Octokit; authType: string }> {
  const token = getInput('github-token');
  const appId = getInput('app-id');
  const privateKey = getInput('private-key');
  const installationId = getInput('installation-id');

  // Prefer GitHub App authentication if app credentials are provided
  if (appId && privateKey) {
    console.log('🔐 Using GitHub App authentication');

    try {
      // Note: createAppAuth is used in the Octokit constructor below

      // If no installation ID provided, try to get it for the current repository
      let finalInstallationId: number | undefined;

      // Validate and parse the installation ID if provided
      if (installationId) {
        finalInstallationId = parseInt(installationId, 10);
        if (isNaN(finalInstallationId) || finalInstallationId <= 0) {
          throw new Error('Invalid installation-id provided. It must be a positive integer.');
        }
      }

      if (!finalInstallationId) {
        const owner = getInput('owner') || process.env.GITHUB_REPOSITORY_OWNER;
        const repo = getInput('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1];

        if (owner && repo) {
          // Create a temporary JWT-authenticated client to find the installation
          const appOctokit = new Octokit({
            authStrategy: createAppAuth,
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
          } catch {
            console.warn(
              '⚠️ Could not auto-detect installation ID. Please check app permissions and installation status.'
            );
            throw new Error(
              'GitHub App installation ID is required but could not be auto-detected. Please ensure the app is installed on this repository or provide the `installation-id` manually.'
            );
          }
        }
      }

      // Create the authenticated Octokit instance
      const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId,
          privateKey,
          installationId: finalInstallationId,
        },
      });

      return { octokit, authType: 'github-app' };
    } catch (error) {
      console.error(
        '❌ GitHub App authentication failed. Please check your App ID, Private Key, and installation permissions.'
      );
      throw new Error(`GitHub App authentication failed`, { cause: error });
    }
  }

  // Fall back to token authentication
  if (token) {
    console.log('🔑 Using GitHub token authentication');
    return {
      octokit: new Octokit({ auth: token }),
      authType: 'token',
    };
  }

  throw new Error('Either github-token or app-id/private-key must be provided for authentication');
}

export async function run(): Promise<void> {
  try {
    const { octokit, authType } = await createAuthenticatedOctokit();
    console.log(`✅ Authenticated successfully using ${authType}`);

    // Get token for passing to CLI bridge (might be undefined if using App auth)
    const token = getInput('github-token') || '';

    // Collect all GitHub Action inputs
    const inputs: GitHubActionInputs = {
      'github-token': token,
      owner: getInput('owner') || process.env.GITHUB_REPOSITORY_OWNER,
      repo: getInput('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1],
      'auto-review': getInput('auto-review'),
      debug: getInput('debug'),
      // GitHub App authentication inputs
      'app-id': getInput('app-id') || undefined,
      'private-key': getInput('private-key') || undefined,
      'installation-id': getInput('installation-id') || undefined,
      // Only collect other inputs if they have values to avoid triggering CLI mode
      checks: getInput('checks') || undefined,
      'output-format': getInput('output-format') || undefined,
      'config-path': getInput('config-path') || undefined,
      'comment-on-pr': getInput('comment-on-pr') || undefined,
      'create-check': getInput('create-check') || undefined,
      'add-labels': getInput('add-labels') || undefined,
      'fail-on-critical': getInput('fail-on-critical') || undefined,
      'fail-on-api-error': getInput('fail-on-api-error') || undefined,
      'min-score': getInput('min-score') || undefined,
      'max-parallelism': getInput('max-parallelism') || undefined,
      // Legacy inputs for backward compatibility
      'visor-config-path': getInput('visor-config-path') || undefined,
      'visor-checks': getInput('visor-checks') || undefined,
    };

    const eventName = process.env.GITHUB_EVENT_NAME;
    const autoReview = inputs['auto-review'] === 'true';

    // Create GitHub context for CLI bridge
    const context: GitHubContext = {
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
    const cliBridge = new ActionCliBridge(token, context);

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
        console.log(
          '🔄 Auto-review enabled - attempting to detect PR context across all event types'
        );

        // Try to detect if we're in a PR context (works for push, pull_request, issue_comment, etc.)
        const prDetected = await detectPRContext(inputs, context, octokit);
        if (prDetected) {
          console.log('✅ PR context detected - using GitHub API for PR analysis');
          await handlePullRequestVisorMode(inputs, context, octokit, authType);
          return;
        } else {
          console.log('ℹ️ No PR context detected - proceeding with CLI mode for general analysis');
        }
      }

      await handleVisorMode(cliBridge, inputs, context, octokit);
      return;
    }

    console.log('🤖 Using legacy GitHub Action mode');
    await handleLegacyMode(octokit, inputs, eventName, autoReview);
  } catch (error) {
    setFailed(error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Handle Visor CLI mode
 */
async function handleVisorMode(
  cliBridge: ActionCliBridge,
  inputs: GitHubActionInputs,
  _context: GitHubContext,
  _octokit: Octokit
): Promise<void> {
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
        const jsonLine = outputLines.find(
          line => line.trim().startsWith('{') && line.trim().endsWith('}')
        );

        if (jsonLine) {
          cliOutput = JSON.parse(jsonLine);
          console.log('📊 CLI Review Results:', cliOutput);

          // Note: PR comment posting is now handled by handlePullRequestVisorMode for PR events
          // CLI mode output is intended for non-PR scenarios
        } else {
          console.log('📄 CLI Output (non-JSON):', result.output);
        }
      } catch (parseError) {
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
        setOutput(key, value);
      }
    } else {
      console.error('❌ Visor CLI execution failed');
      console.error(result.error || result.output);
      setFailed(result.error || 'CLI execution failed');
    }
  } catch (error) {
    console.error('❌ Visor mode error:', error);
    setFailed(error instanceof Error ? error.message : 'Visor mode failed');
  }
}

function mapGitHubEventToTrigger(
  eventName?: string,
  action?: string
): import('./types/config').EventTrigger {
  if (!eventName) return 'pr_updated';

  switch (eventName) {
    case 'pull_request':
      if (action === 'opened') return 'pr_opened';
      if (action === 'synchronize' || action === 'edited') return 'pr_updated';
      return 'pr_updated';
    case 'issues':
      if (action === 'opened') return 'issue_opened';
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
async function handleLegacyMode(
  octokit: Octokit,
  inputs: GitHubActionInputs,
  eventName: string | undefined,
  autoReview: boolean
): Promise<void> {
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

/**
 * Recursively resolve dependencies for a set of check IDs
 */
function resolveDependencies(
  checkIds: string[],
  config: import('./types/config').VisorConfig | undefined,
  resolved: Set<string> = new Set(),
  visiting: Set<string> = new Set()
): string[] {
  const result: string[] = [];

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

async function handleIssueComment(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
  const comment = context.event?.comment;
  const issue = context.event?.issue;

  if (!comment || !issue) {
    console.log('No comment or issue found in context');
    return;
  }

  // Prevent recursion: skip if comment is from visor itself
  if (
    comment.body &&
    (comment.body.includes('<!-- visor-comment-id:') ||
      comment.body.includes('*Powered by [Visor]'))
  ) {
    console.log('Skipping visor comment to prevent recursion');
    return;
  }

  // Process comments on both issues and PRs
  // (issue.pull_request exists for PR comments, doesn't exist for issue comments)

  // Load configuration to get available commands
  const configManager = new ConfigManager();
  let config: import('./types/config').VisorConfig | undefined;
  const commandRegistry: CommandRegistry = {};

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
  } catch {
    console.log('Could not load config, using defaults');
    config = undefined;
    // Default commands when no config is available
    commandRegistry['review'] = ['security', 'performance', 'style', 'architecture'];
  }

  // Parse comment with available commands
  const availableCommands = Object.keys(commandRegistry);
  const command = parseComment(comment.body, availableCommands);
  if (!command) {
    console.log('No valid command found in comment');
    return;
  }

  console.log(`Processing command: ${command.type}`);

  const prNumber = issue.number;
  const analyzer = new PRAnalyzer(octokit);
  const reviewer = new PRReviewer(octokit);

  switch (command.type) {
    case 'status':
      const statusPrInfo = await analyzer.fetchPRDiff(
        owner,
        repo,
        prNumber,
        undefined,
        'issue_comment'
      );
      const statusComment =
        `## 📊 PR Status\n\n` +
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
        body: getHelpText(commandRegistry),
      });
      break;

    default:
      // Handle custom commands from config
      if (commandRegistry[command.type]) {
        const initialCheckIds = commandRegistry[command.type];
        // Resolve all dependencies recursively
        const checkIds = resolveDependencies(initialCheckIds, config);
        console.log(
          `Running checks for command /${command.type} (initial: ${initialCheckIds.join(', ')}, resolved: ${checkIds.join(', ')})`
        );

        const prInfo = await analyzer.fetchPRDiff(
          owner,
          repo,
          prNumber,
          undefined,
          'issue_comment'
        );

        // Extract common arguments
        const focus = command.args?.find(arg => arg.startsWith('--focus='))?.split('=')[1] as
          | 'security'
          | 'performance'
          | 'style'
          | 'all'
          | undefined;
        const format = command.args?.find(arg => arg.startsWith('--format='))?.split('=')[1] as
          | 'table'
          | 'json'
          | 'markdown'
          | 'sarif'
          | undefined;

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
          config: config as import('./types/config').VisorConfig,
          checks: checkIds,
          parallelExecution: false,
        });

        await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
          focus,
          format,
        });

        // Calculate total check results from grouped results
        const totalChecks = Object.values(groupedResults).flat().length;
        setOutput('checks-executed', totalChecks.toString());
      }
      break;
  }
}

async function handlePullRequestEvent(
  octokit: Octokit,
  owner: string,
  repo: string,
  inputs?: GitHubActionInputs
): Promise<void> {
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
    console.log(
      `Unsupported PR action: ${action}. Supported actions: ${supportedActions.join(', ')}`
    );
    return;
  }

  console.log(`Auto-reviewing PR #${pullRequest.number} (action: ${action})`);

  const prNumber = pullRequest.number;
  const analyzer = new PRAnalyzer(octokit);
  const reviewer = new PRReviewer(octokit);

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
    } else {
      // Fallback to full analysis if no commit SHA available
      prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    }
  } else {
    // For opened and edited events, do full PR analysis
    prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
  }

  // Load config for the review
  const configManager = new ConfigManager();
  let config;
  try {
    config = await configManager.findAndLoadConfig();
  } catch {
    // Fall back to a basic configuration for PR auto-review
    config = {
      version: '1.0',
      output: {
        pr_comment: {
          format: 'markdown' as const,
          group_by: 'check' as const,
          collapse: false,
        },
      },
      checks: {
        'auto-review': {
          type: 'ai' as const,
          on: ['pr_opened', 'pr_updated'] as import('./types/config').EventTrigger[],
          prompt: `Review this pull request comprehensively. Look for security issues, performance problems, code quality, bugs, and suggest improvements. Action: ${action}`,
        },
      },
    };
  }

  // Create review options, including debug if enabled
  const reviewOptions = {
    debug: inputs?.debug === 'true',
    config: config as import('./types/config').VisorConfig,
    checks: ['auto-review'],
    parallelExecution: false,
  };

  // Create GitHub check runs for legacy auto-review
  let checkResults: {
    checkRunMap: Map<string, { id: number; url: string }> | null;
    checksApiAvailable: boolean;
    checkRunsCreated: number;
    checkRunUrls: string[];
  } | null = null;
  if (inputs && inputs['github-token']) {
    checkResults = await createGitHubChecks(
      octokit,
      inputs,
      owner,
      repo,
      pullRequest.head?.sha || 'unknown',
      ['auto-review'],
      config
    );
  }

  // Update checks to in-progress status
  if (checkResults) {
    await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);
  }

  // Perform the review with debug options
  const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

  // Complete GitHub check runs with results
  if (checkResults) {
    await completeGitHubChecks(
      octokit,
      owner,
      repo,
      checkResults.checkRunMap,
      groupedResults,
      config
    );
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
    console.log(
      `✅ ${action === 'opened' ? 'Created' : 'Updated'} PR review comment with actual results`
    );
  } catch (commentError) {
    // Don't fail the action if comment posting fails - we already have the results
    console.warn(`⚠️  Failed to post/update comment: ${commentError}`);
  }

  // Set outputs
  setOutput('auto-review-completed', 'true');
  setOutput('checks-executed', Object.values(groupedResults).flat().length.toString());
  setOutput('pr-action', action);
  setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');

  // Set GitHub check run outputs
  setOutput('checks-api-available', checkResults?.checksApiAvailable.toString() || 'false');
  setOutput('check-runs-created', checkResults?.checkRunsCreated.toString() || '0');
  setOutput('check-runs-urls', checkResults?.checkRunUrls.join(',') || '');
}

async function handleRepoInfo(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const { data: repoData } = await octokit.rest.repos.get({
    owner,
    repo,
  });

  setOutput('repo-name', repoData.name);
  setOutput('repo-description', repoData.description || '');
  setOutput('repo-stars', repoData.stargazers_count.toString());

  console.log(`Repository: ${repoData.full_name}`);
  console.log(`Description: ${repoData.description || 'No description'}`);
  console.log(`Stars: ${repoData.stargazers_count}`);
}

/**
 * Filter checks based on their if conditions and API requirements
 */
async function filterChecksToExecute(
  checksToRun: string[],
  config: import('./types/config').VisorConfig,
  prInfo?: import('./pr-analyzer').PRInfo
): Promise<string[]> {
  const filteredChecks: string[] = [];

  // Create a basic context for condition evaluation
  const context = {
    files: prInfo?.files || [],
    filesChanged: prInfo?.files.map(f => f.filename) || [],
    event: 'pull_request',
    environment: process.env as Record<string, string>,
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
        const { FailureConditionEvaluator } = await import('./failure-condition-evaluator');
        const evaluator = new FailureConditionEvaluator();

        const shouldRun = await evaluator.evaluateIfCondition(checkName, checkConfig.if, context);

        if (shouldRun) {
          filteredChecks.push(checkName);
        } else {
          console.log(`⚠️ Skipping check '${checkName}' - if condition not met`);
        }
      } catch (error) {
        console.warn(`Warning: Could not evaluate if condition for ${checkName}:`, error);
        // Include the check if we can't evaluate the condition
        filteredChecks.push(checkName);
      }
    } else {
      // No condition, include the check
      filteredChecks.push(checkName);
    }
  }

  return filteredChecks;
}

/**
 * Create GitHub check runs for individual checks if enabled
 */
async function createGitHubChecks(
  octokit: Octokit,
  inputs: GitHubActionInputs,
  owner: string,
  repo: string,
  headSha: string,
  checksToRun: string[],
  config: import('./types/config').VisorConfig
): Promise<{
  checkRunMap: Map<string, { id: number; url: string }> | null;
  checksApiAvailable: boolean;
  checkRunsCreated: number;
  checkRunUrls: string[];
}> {
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
    const checkService = new GitHubCheckService(octokit);
    const checkRunMap = new Map<string, { id: number; url: string }>();
    const checkRunUrls: string[] = [];

    // Get custom name prefix if specified
    const namePrefix = config?.output?.github_checks?.name_prefix || 'Visor';

    if (perCheckMode) {
      console.log(`🔍 Creating individual GitHub check runs for ${checksToRun.length} checks...`);

      // Create individual check runs for each configured check
      for (const checkName of checksToRun) {
        try {
          const checkRunOptions: CheckRunOptions = {
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
        } catch (error) {
          console.error(`❌ Failed to create check run for ${checkName}:`, error);
          // Continue with other checks even if one fails
        }
      }
    } else {
      // Create a single check run for all checks
      console.log(`🔍 Creating single GitHub check run for ${checksToRun.length} checks...`);

      try {
        const checkRunOptions: CheckRunOptions = {
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
      } catch (error) {
        console.error(`❌ Failed to create combined check run:`, error);
      }
    }

    return {
      checkRunMap,
      checksApiAvailable: true,
      checkRunsCreated: checkRunMap.size,
      checkRunUrls,
    };
  } catch (error) {
    // Check if this is a permissions error
    if (
      error instanceof Error &&
      (error.message.includes('403') || error.message.includes('checks:write'))
    ) {
      console.warn(
        '⚠️ GitHub checks API not available - insufficient permissions. Check runs will be skipped.'
      );
      console.warn(
        '💡 To enable check runs, ensure your GitHub token has "checks:write" permission.'
      );
      return {
        checkRunMap: null,
        checksApiAvailable: false,
        checkRunsCreated: 0,
        checkRunUrls: [],
      };
    } else {
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
async function updateChecksInProgress(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunMap: Map<string, { id: number; url: string }> | null
): Promise<void> {
  if (!checkRunMap) return;

  const checkService = new GitHubCheckService(octokit);

  for (const [checkName, checkRun] of checkRunMap) {
    try {
      await checkService.updateCheckRunInProgress(owner, repo, checkRun.id, {
        title: `Analyzing with ${checkName}...`,
        summary: `AI-powered analysis is in progress for ${checkName} check.`,
      });
      console.log(`🔄 Updated ${checkName} check to in-progress status`);
    } catch (error) {
      console.error(`❌ Failed to update ${checkName} check to in-progress:`, error);
    }
  }
}

/**
 * Complete GitHub check runs with results
 */
async function completeGitHubChecks(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunMap: Map<string, { id: number; url: string }> | null,
  groupedResults: GroupedCheckResults,
  config: import('./types/config').VisorConfig
): Promise<void> {
  if (!checkRunMap) return;

  const checkService = new GitHubCheckService(octokit);
  const perCheckMode = config?.output?.github_checks?.per_check !== false;

  console.log(`🏁 Completing ${checkRunMap.size} GitHub check runs...`);

  if (perCheckMode && !checkRunMap.has('combined')) {
    // Per-check mode: complete individual check runs
    await completeIndividualChecks(checkService, owner, repo, checkRunMap, groupedResults, config);
  } else {
    // Combined mode: complete single check run with all results
    await completeCombinedCheck(checkService, owner, repo, checkRunMap, groupedResults, config);
  }
}

/**
 * Extract ReviewIssue[] from GroupedCheckResults content by parsing the rendered text
 * This function parses the structured content created by CheckExecutionEngine.convertReviewSummaryToGroupedResults()
 */
function extractIssuesFromGroupedResults(groupedResults: GroupedCheckResults): ReviewIssue[] {
  const issues: ReviewIssue[] = [];

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
        const severity = severityUpper.toLowerCase() as 'info' | 'warning' | 'error' | 'critical';
        const line = parseInt(lineStr, 10);

        // Create ReviewIssue with proper format for GitHub annotations
        const issue: ReviewIssue = {
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
async function completeIndividualChecks(
  checkService: GitHubCheckService,
  owner: string,
  repo: string,
  checkRunMap: Map<string, { id: number; url: string }>,
  groupedResults: GroupedCheckResults,
  config: import('./types/config').VisorConfig
): Promise<void> {
  // Create failure condition evaluator
  const { FailureConditionEvaluator } = await import('./failure-condition-evaluator');
  const failureEvaluator = new FailureConditionEvaluator();

  // Extract all issues once and group by check name for O(N) complexity
  const allIssues = extractIssuesFromGroupedResults(groupedResults);
  const issuesByCheck = new Map<string, import('./reviewer').ReviewIssue[]>();

  // Initialize empty arrays for all checks
  for (const checkName of checkRunMap.keys()) {
    issuesByCheck.set(checkName, []);
  }

  // Group issues by check name
  for (const issue of allIssues) {
    const checkName = issue.ruleId?.split('/')[0];
    if (checkName && issuesByCheck.has(checkName)) {
      issuesByCheck.get(checkName)!.push(issue);
    }
  }

  for (const [checkName, checkRun] of checkRunMap) {
    try {
      // Get pre-grouped issues for this check - O(1) lookup
      const checkIssues = issuesByCheck.get(checkName) || [];

      // Evaluate failure conditions based on fail_if configuration
      const failureResults: import('./types/config').FailureConditionResult[] = [];

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
        const failed = await failureEvaluator.evaluateSimpleCondition(
          checkName,
          config?.checks?.[checkName]?.schema || 'plain',
          config?.checks?.[checkName]?.group || 'default',
          checkReviewSummary,
          effectiveFailIf
        );

        if (failed) {
          const isCheckSpecific = checkFailIf !== undefined;
          failureResults.push({
            conditionName: isCheckSpecific ? `${checkName}_fail_if` : 'global_fail_if',
            expression: effectiveFailIf,
            failed: true,
            severity: 'error' as const,
            message: isCheckSpecific
              ? `Check ${checkName} failure condition met`
              : 'Global failure condition met',
            haltExecution: false,
          });
        }
      }

      await checkService.completeCheckRun(
        owner,
        repo,
        checkRun.id,
        checkName,
        failureResults,
        checkIssues // Pass extracted issues for GitHub annotations
      );

      console.log(
        `✅ Completed ${checkName} check with ${checkIssues.length} issues, ${failureResults.length} failure conditions evaluated`
      );
    } catch (error) {
      console.error(`❌ Failed to complete ${checkName} check:`, error);
      await markCheckAsFailed(checkService, owner, repo, checkRun.id, checkName, error);
    }
  }
}

/**
 * Complete combined GitHub check run
 */
async function completeCombinedCheck(
  checkService: GitHubCheckService,
  owner: string,
  repo: string,
  checkRunMap: Map<string, { id: number; url: string }>,
  groupedResults: GroupedCheckResults,
  config: import('./types/config').VisorConfig
): Promise<void> {
  const combinedCheckRun = checkRunMap.get('combined');
  if (!combinedCheckRun) return;

  // Create failure condition evaluator
  const { FailureConditionEvaluator } = await import('./failure-condition-evaluator');
  const failureEvaluator = new FailureConditionEvaluator();

  try {
    // Extract all issues from the grouped results for the combined check
    const allIssues = extractIssuesFromGroupedResults(groupedResults);

    // Evaluate failure conditions for combined check
    const failureResults: import('./types/config').FailureConditionResult[] = [];

    // Create a combined ReviewSummary with all issues
    const combinedReviewSummary = {
      issues: allIssues,
      suggestions: [],
    };

    // Evaluate global fail_if for the combined check
    const globalFailIf = config?.fail_if;
    if (globalFailIf) {
      const failed = await failureEvaluator.evaluateSimpleCondition(
        'combined',
        'plain',
        'combined',
        combinedReviewSummary,
        globalFailIf
      );

      if (failed) {
        failureResults.push({
          conditionName: 'global_fail_if',
          expression: globalFailIf,
          failed: true,
          severity: 'error' as const,
          message: 'Global failure condition met',
          haltExecution: false,
        });
      }
    }

    await checkService.completeCheckRun(
      owner,
      repo,
      combinedCheckRun.id,
      'Code Review',
      failureResults,
      allIssues // Pass all extracted issues for GitHub annotations
    );

    console.log(
      `✅ Completed combined check with ${allIssues.length} issues, ${failureResults.length} failure conditions evaluated`
    );
  } catch (error) {
    console.error(`❌ Failed to complete combined check:`, error);
    await markCheckAsFailed(checkService, owner, repo, combinedCheckRun.id, 'Code Review', error);
  }
}

/**
 * Mark a check as failed due to execution error
 */
async function markCheckAsFailed(
  checkService: GitHubCheckService,
  owner: string,
  repo: string,
  checkRunId: number,
  checkName: string,
  error: unknown
): Promise<void> {
  try {
    await checkService.completeCheckRun(
      owner,
      repo,
      checkRunId,
      checkName,
      [],
      [],
      error instanceof Error ? error.message : 'Unknown error occurred'
    );
  } catch (finalError) {
    console.error(`❌ Failed to mark ${checkName} check as failed:`, finalError);
  }
}

/**
 * Handle PR review using Visor config but with proper GitHub API PR diff analysis
 */
async function handlePullRequestVisorMode(
  inputs: GitHubActionInputs,
  _context: GitHubContext,
  octokit: Octokit,
  _authType?: string
): Promise<void> {
  const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
  const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];

  if (!owner || !repo) {
    console.error('❌ Missing required GitHub parameters for PR analysis');
    setFailed('Missing required GitHub parameters');
    return;
  }

  // Use the provided authenticated Octokit instance
  const prDetector = new PRDetector(octokit, inputs.debug === 'true');

  // Convert GitHub context to our format
  const eventContext: GitHubEventContext = {
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
    console.error(
      `❌ No PR found using any detection strategy: ${prResult.details || 'Unknown reason'}`
    );
    if (inputs.debug === 'true') {
      console.error('Available detection strategies:');
      prDetector.getDetectionStrategies().forEach(strategy => console.error(`  ${strategy}`));
    }
    setFailed('No PR number found');
    return;
  }

  const prNumber = prResult.prNumber;
  console.log(
    `✅ Found PR #${prNumber} using ${prResult.source} (confidence: ${prResult.confidence})`
  );
  if (prResult.details) {
    console.log(`   Details: ${prResult.details}`);
  }

  console.log(`🔍 Analyzing PR #${prNumber} using Visor config (action: ${action})`);

  try {
    // Use the existing PR analysis infrastructure but with Visor config
    const analyzer = new PRAnalyzer(octokit);
    const reviewer = new PRReviewer(octokit);

    // Load Visor config
    const configManager = new ConfigManager();
    let config;
    const configPath = inputs['config-path'];
    if (configPath) {
      try {
        config = await configManager.loadConfig(configPath);
        console.log(`📋 Loaded Visor config from: ${configPath}`);
      } catch (error) {
        console.error(`⚠️ Could not load config from ${configPath}:`, error);
        config = await configManager.findAndLoadConfig();
      }
    } else {
      // Try to find and load config from default locations (.visor.yaml)
      config = await configManager.findAndLoadConfig();
      const hasCustomConfig = config.checks && Object.keys(config.checks).length > 0;
      if (hasCustomConfig) {
        console.log(`📋 Loaded Visor config from default location (.visor.yaml)`);
      } else {
        console.log(`📋 Using default Visor configuration`);
      }
    }

    // Extract checks from config
    const configChecks = Object.keys(config.checks || {});
    const checksToRun =
      configChecks.length > 0 ? configChecks : ['security', 'performance', 'style', 'architecture'];
    console.log(`🔧 Running checks: ${checksToRun.join(', ')}`);

    // Map GitHub event name to our EventTrigger format
    const eventType = mapGitHubEventToTrigger(process.env.GITHUB_EVENT_NAME, action);

    // Fetch PR diff using GitHub API
    const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    console.log(`📄 Found ${prInfo.files.length} changed files`);

    if (prInfo.files.length === 0) {
      console.log('⚠️ No files changed in this PR - skipping review');

      // Set basic outputs
      setOutput('auto-review-completed', 'true');
      setOutput('issues-found', '0');
      setOutput('pr-action', action || 'unknown');
      setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
      return;
    }

    // Filter checks based on their conditions
    const checksToExecute = await filterChecksToExecute(checksToRun, config, prInfo);
    console.log(`📋 Checks that will execute: ${checksToExecute.join(', ')}`);

    if (checksToExecute.length === 0) {
      console.log('⚠️ No checks meet the execution conditions - skipping review');
      // Set basic outputs
      setOutput('auto-review-completed', 'true');
      setOutput('issues-found', '0');
      setOutput('checks-executed', '0');
      return;
    }

    // Create a custom review options with Visor config
    const reviewOptions = {
      debug: inputs.debug === 'true',
      config: config,
      checks: checksToExecute,
      parallelExecution: true,
    };

    // Fetch PR info to get commit SHA for metadata
    const { data: pullRequest } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Create GitHub check runs only for checks that will execute
    const checkResults = await createGitHubChecks(
      octokit,
      inputs,
      owner,
      repo,
      pullRequest.head.sha,
      checksToExecute,
      config
    );

    // Update checks to in-progress status
    await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);

    // Perform the review
    console.log('🤖 Starting parallel AI review with Visor config...');
    const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

    // Complete GitHub check runs with results
    if (checkResults) {
      await completeGitHubChecks(
        octokit,
        owner,
        repo,
        checkResults.checkRunMap,
        groupedResults,
        config
      );
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
    const hasApiErrors =
      allContent.includes('API rate limit') ||
      allContent.includes('403') ||
      allContent.includes('401') ||
      allContent.includes('authentication') ||
      allContent.includes('API key');

    if (hasApiErrors) {
      console.error('🚨 Critical API errors detected in review content');

      // Check if we should fail on API errors
      const failOnApiError = inputs['fail-on-api-error'] === 'true';
      if (failOnApiError) {
        setFailed(
          'Critical API errors detected in review content. Please check your API credentials.'
        );
        return;
      }
    }

    // Set outputs
    setOutput('auto-review-completed', 'true');
    setOutput('checks-executed', Object.values(groupedResults).flat().length.toString());
    setOutput('pr-action', action || 'unknown');
    setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
    setOutput('visor-config-used', 'true');
    setOutput('checks-run', checksToRun.join(','));
    setOutput('api-errors-found', hasApiErrors ? '1' : '0');

    // Set GitHub check run outputs
    setOutput('checks-api-available', checkResults.checksApiAvailable.toString());
    setOutput('check-runs-created', checkResults.checkRunsCreated.toString());
    setOutput('check-runs-urls', checkResults.checkRunUrls.join(','));
  } catch (error) {
    console.error('❌ Error in Visor PR analysis:', error);
    setFailed(error instanceof Error ? error.message : 'Visor PR analysis failed');
  }
}

/**
 * Detect if we're in a PR context for any GitHub event type
 */
async function detectPRContext(
  inputs: GitHubActionInputs,
  context: GitHubContext,
  octokit: Octokit
): Promise<boolean> {
  try {
    const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
    const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];

    if (!owner || !repo) {
      return false;
    }

    // Use the provided authenticated Octokit instance
    const prDetector = new PRDetector(octokit, inputs.debug === 'true');

    // Convert GitHub context to our format
    const eventContext: GitHubEventContext = {
      event_name: context.event_name,
      repository: {
        owner: { login: owner },
        name: repo,
      },
      event: context.event as GitHubEventContext['event'],
      payload: context.payload || {},
    };

    const prResult = await prDetector.detectPRNumber(eventContext, owner, repo);
    return prResult.prNumber !== null;
  } catch (error) {
    console.error('Error detecting PR context:', error);
    return false;
  }
}

if (require.main === module) {
  run();
}
