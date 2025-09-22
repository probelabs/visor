/* eslint-disable @typescript-eslint/no-explicit-any */
// GitHub event objects have complex dynamic structures that are difficult to fully type
// Using 'any' for these objects is acceptable as they come from external GitHub webhooks

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText, CommandRegistry } from './commands';
import { PRAnalyzer, PRInfo } from './pr-analyzer';
import { PRReviewer, GroupedCheckResults, ReviewIssue } from './reviewer';
import { GitHubActionInputs, GitHubContext } from './action-cli-bridge';
import { ConfigManager } from './config';
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

    // Collect all GitHub Action inputs
    const inputs: GitHubActionInputs = {
      'github-token': getInput('github-token') || '',
      owner: getInput('owner') || process.env.GITHUB_REPOSITORY_OWNER,
      repo: getInput('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1],
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
      'ai-provider': getInput('ai-provider') || undefined,
      'ai-model': getInput('ai-model') || undefined,
      // Legacy inputs for backward compatibility
      'visor-config-path': getInput('visor-config-path') || undefined,
      'visor-checks': getInput('visor-checks') || undefined,
    };

    const eventName = process.env.GITHUB_EVENT_NAME;

    // Load GitHub event data from event file
    let eventData: any = {};
    if (process.env.GITHUB_EVENT_PATH) {
      try {
        const fs = await import('fs');
        const eventContent = fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8');
        eventData = JSON.parse(eventContent);
      } catch (error) {
        console.error('Failed to load GitHub event data:', error);
      }
    }

    // Create GitHub context for CLI bridge
    const context: GitHubContext = {
      event_name: eventName || 'unknown',
      repository: process.env.GITHUB_REPOSITORY
        ? {
            owner: { login: process.env.GITHUB_REPOSITORY.split('/')[0] },
            name: process.env.GITHUB_REPOSITORY.split('/')[1],
          }
        : undefined,
      event: eventData,
      payload: eventData,
    };

    // Debug logging for inputs
    console.log('Debug: inputs.debug =', inputs.debug);
    console.log('Debug: inputs.checks =', inputs.checks);
    console.log('Debug: inputs.config-path =', inputs['config-path']);
    console.log('Debug: inputs.visor-checks =', inputs['visor-checks']);
    console.log('Debug: inputs.visor-config-path =', inputs['visor-config-path']);

    // Always use config-driven mode in GitHub Actions
    // The CLI mode is only for local development, not for GitHub Actions
    console.log('🤖 Using config-driven mode');

    // Load config to determine which checks should run for this event
    const configManager = new ConfigManager();
    let config: import('./types/config').VisorConfig;

    // First try to load user config, then fall back to defaults/.visor.yaml
    const configPath = inputs['config-path'] || inputs['visor-config-path'];

    try {
      if (configPath) {
        // Load specified config
        config = await configManager.loadConfig(configPath);
        console.log(`📋 Loaded config from: ${configPath}`);
      } else {
        // Try to find config in project
        config = await configManager.findAndLoadConfig();
        console.log('📋 Loaded Visor config from project');
      }
    } catch (configError) {
      // Log the error for debugging
      console.warn(
        '⚠️ Error loading config:',
        configError instanceof Error ? configError.message : String(configError)
      );

      // Fall back to bundled default config
      const bundledConfig = configManager.loadBundledDefaultConfig();
      if (bundledConfig) {
        config = bundledConfig;
        console.log('📋 Using bundled default configuration (fallback due to error)');
      } else {
        // Ultimate fallback if even defaults/.visor.yaml can't be loaded
        config = {
          version: '1.0',
          checks: {},
          output: {
            pr_comment: {
              format: 'markdown' as const,
              group_by: 'check' as const,
              collapse: false,
            },
          },
        };
        console.log('⚠️ Could not load defaults/.visor.yaml, using minimal configuration');
      }
    }

    // Determine which event we're handling and run appropriate checks
    await handleEvent(octokit, inputs, eventName, context, config);
  } catch (error) {
    // Import error classes dynamically to avoid circular dependencies
    const { ClaudeCodeSDKNotInstalledError, ClaudeCodeAPIKeyMissingError } = await import(
      './providers/claude-code-check-provider'
    ).catch(() => ({ ClaudeCodeSDKNotInstalledError: null, ClaudeCodeAPIKeyMissingError: null }));

    // Provide user-friendly error messages for known errors
    if (ClaudeCodeSDKNotInstalledError && error instanceof ClaudeCodeSDKNotInstalledError) {
      const errorMessage = [
        'Claude Code SDK is not installed.',
        'To use the claude-code provider, install: npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk',
      ].join(' ');
      setFailed(errorMessage);
    } else if (ClaudeCodeAPIKeyMissingError && error instanceof ClaudeCodeAPIKeyMissingError) {
      const errorMessage = [
        'No API key found for Claude Code provider.',
        'Set CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY in your GitHub secrets.',
      ].join(' ');
      setFailed(errorMessage);
    } else {
      setFailed(error instanceof Error ? error.message : 'Unknown error');
    }
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
 * Handle events based on config
 */
async function handleEvent(
  octokit: Octokit,
  inputs: GitHubActionInputs,
  eventName: string | undefined,
  context: GitHubContext,
  config: import('./types/config').VisorConfig
): Promise<void> {
  const owner = inputs.owner;
  const repo = inputs.repo;

  if (!owner || !repo) {
    throw new Error('Owner and repo are required');
  }

  console.log(`Event: ${eventName}, Owner: ${owner}, Repo: ${repo}`);

  // Debug: Log the checks that are available in the loaded config
  const allChecks = Object.keys(config.checks || {});
  console.log(`📚 Total checks in loaded config: ${allChecks.length}`);
  if (allChecks.length <= 10) {
    // Only log check names if there aren't too many
    console.log(`📚 Available checks: ${allChecks.join(', ')}`);
  }

  // Map GitHub event to our event trigger format
  const eventType = mapGitHubEventToTrigger(eventName, context.event?.action);

  // Find checks that should run for this event
  let checksToRun: string[] = [];

  // First, get all checks that are configured for this event type
  const eventChecks: string[] = [];
  for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
    // Check if this check should run for this event
    const checkEvents = checkConfig.on || ['pr_opened', 'pr_updated'];
    if (checkEvents.includes(eventType)) {
      eventChecks.push(checkName);
    }
  }

  // Now apply the 'checks' input filter if provided
  const checksInput = inputs.checks || inputs['visor-checks'];
  if (checksInput && checksInput.trim() !== '') {
    const requestedChecks = checksInput.split(',').map(c => c.trim());

    if (requestedChecks.includes('all')) {
      // If 'all' is specified, run all event checks
      checksToRun = eventChecks;
      console.log('📋 Running all available checks for this event');
    } else {
      // Filter to only the requested checks that are also configured for this event
      // Map simplified check names to actual config check names if needed
      for (const requested of requestedChecks) {
        // Try exact match first
        if (eventChecks.includes(requested)) {
          checksToRun.push(requested);
        } else {
          // Try with '-check' suffix (e.g., 'security' -> 'security-check')
          const withSuffix = `${requested}-check`;
          if (eventChecks.includes(withSuffix)) {
            checksToRun.push(withSuffix);
          } else {
            // Try to find any check that contains the requested string
            const matching = eventChecks.filter(check =>
              check.toLowerCase().includes(requested.toLowerCase())
            );
            checksToRun.push(...matching);
          }
        }
      }
      console.log(`📋 Running requested checks: ${requestedChecks.join(', ')}`);
    }
  } else {
    // No checks input provided, run all event checks
    checksToRun = eventChecks;
  }

  if (checksToRun.length === 0) {
    console.log(`ℹ️ No checks configured to run for event: ${eventType}`);
    return;
  }

  console.log(`🔧 Checks to run for ${eventType}: ${checksToRun.join(', ')}`);

  // Handle different GitHub events
  switch (eventName) {
    case 'issue_comment':
      await handleIssueComment(octokit, owner, repo, context, inputs, config, checksToRun);
      break;
    case 'pull_request':
      // Run the checks that are configured for this event
      await handlePullRequestWithConfig(octokit, owner, repo, inputs, config, checksToRun, context);
      break;
    case 'issues':
      // Handle issue events (opened, closed, etc)
      await handleIssueEvent(octokit, owner, repo, context, inputs, config, checksToRun);
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

/**
 * Handle issue events (opened, edited, etc)
 */
async function handleIssueEvent(
  octokit: Octokit,
  owner: string,
  repo: string,
  context: GitHubContext,
  inputs: GitHubActionInputs,
  config: import('./types/config').VisorConfig,
  checksToRun: string[]
): Promise<void> {
  const issue = context.event?.issue as any;
  const action = context.event?.action as string | undefined;

  if (!issue) {
    console.log('No issue found in context');
    return;
  }

  // Skip if this is a pull request (has pull_request property)
  if (issue.pull_request) {
    console.log('Skipping PR-related issue event');
    return;
  }

  console.log(
    `Processing issue #${issue.number} event: ${action} with checks: ${checksToRun.join(', ')}`
  );

  // For issue events, we need to create a PR-like structure for the checks to process
  // This allows us to reuse the existing check infrastructure
  const prInfo: any = {
    number: issue.number,
    title: issue.title || '',
    body: issue.body || '',
    author: issue.user?.login || 'unknown',
    base: 'main', // Issues don't have branches
    head: 'issue', // Issues don't have branches
    files: [], // No file changes for issues
    additions: 0,
    deletions: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    eventType: mapGitHubEventToTrigger('issues', action),
    isIssue: true, // Flag to indicate this is an issue, not a PR
    eventContext: context.event, // Pass the full event context for templates
  };

  // Fetch comment history for issues
  try {
    console.log(`💬 Fetching comment history for issue #${issue.number}`);
    const analyzer = new PRAnalyzer(octokit);
    const comments = await analyzer.fetchPRComments(owner, repo, issue.number);
    prInfo.comments = comments;
    console.log(`✅ Retrieved ${comments.length} comments for issue`);
  } catch (error) {
    console.warn(
      `⚠️ Could not fetch issue comments: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    prInfo.comments = [];
  }

  // Run the checks using CheckExecutionEngine
  const { CheckExecutionEngine } = await import('./check-execution-engine');
  const engine = new CheckExecutionEngine();

  try {
    const result = await engine.executeGroupedChecks(
      prInfo,
      checksToRun,
      undefined, // timeout
      config,
      undefined, // outputFormat
      inputs.debug === 'true'
    );

    // Format and post results as a comment on the issue
    if (Object.keys(result).length > 0) {
      let commentBody = '';

      // Directly use check content without adding extra headers
      for (const checks of Object.values(result)) {
        for (const check of checks) {
          if (check.content && check.content.trim()) {
            commentBody += `${check.content}\n\n`;
          }
        }
      }

      commentBody += `\n---\n*Powered by [Visor](https://github.com/probelabs/visor)*`;

      // Post comment to the issue
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: commentBody,
      });

      console.log(`✅ Posted issue assistant results to issue #${issue.number}`);
    } else {
      console.log('No results from issue assistant checks');
    }

    // Set outputs for GitHub Actions
    setOutput('review-completed', 'true');
    setOutput('checks-executed', checksToRun.length.toString());
  } catch (error) {
    console.error('Error running issue assistant checks:', error);
    setOutput('review-completed', 'false');
    setOutput('error', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

async function handleIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  context: GitHubContext,
  inputs: GitHubActionInputs,
  actionConfig?: import('./types/config').VisorConfig,
  _actionChecksToRun?: string[]
): Promise<void> {
  const comment = context.event?.comment as any;
  const issue = context.event?.issue as any;

  if (!comment || !issue) {
    console.log('No comment or issue found in context');
    return;
  }

  // Prevent recursion: skip if comment is from visor itself
  // Check both comment author and content markers
  const isVisorBot =
    comment.user?.login === 'visor[bot]' ||
    comment.user?.login === 'github-actions[bot]' ||
    comment.user?.type === 'Bot';

  const hasVisorMarkers =
    comment.body &&
    (comment.body.includes('<!-- visor-comment-id:') ||
      comment.body.includes('*Powered by [Visor](https://probelabs.com/visor)') ||
      comment.body.includes('*Powered by [Visor](https://github.com/probelabs/visor)'));

  if (isVisorBot || hasVisorMarkers) {
    console.log(
      `Skipping visor comment to prevent recursion. Author: ${comment.user?.login}, Type: ${comment.user?.type}, Has markers: ${hasVisorMarkers}`
    );
    return;
  }

  // Process comments on both issues and PRs
  // (issue.pull_request exists for PR comments, doesn't exist for issue comments)
  const isPullRequest = !!issue.pull_request;

  // Load configuration to get available commands
  const configManager = new ConfigManager();
  let config: import('./types/config').VisorConfig | undefined;
  const commandRegistry: CommandRegistry = {};

  // Use provided config if available (from action), otherwise load it
  if (actionConfig) {
    config = actionConfig;
  } else {
    try {
      config = await configManager.findAndLoadConfig();
    } catch {
      console.log('Could not load config, using defaults');
      config = undefined;
    }
  }

  // Build command registry from config
  if (config?.checks) {
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
  } else {
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
      if (isPullRequest) {
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
          `\n---\n\n` +
          `*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;

        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: statusComment,
        });
      } else {
        const statusComment =
          `## 📊 Issue Status\n\n` +
          `**Title:** ${issue.title || 'N/A'}\n` +
          `**Author:** ${issue.user?.login || 'unknown'}\n` +
          `**State:** ${issue.state || 'open'}\n` +
          `**Comments:** ${issue.comments || 0}\n` +
          `**Created:** ${issue.created_at || 'unknown'}\n` +
          `\n---\n\n` +
          `*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;

        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: statusComment,
        });
      }
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

        // Different handling for PRs vs Issues
        let prInfo: PRInfo;
        if (isPullRequest) {
          // It's a PR comment - fetch the PR diff
          prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, 'issue_comment');
          // Add event context for templates and XML generation
          (prInfo as any).eventContext = context.event;
        } else {
          // It's an issue comment - create a minimal PRInfo structure for issue assistant
          prInfo = {
            number: issue.number,
            title: issue.title || '',
            body: issue.body || '',
            author: issue.user?.login || 'unknown',
            base: 'main',
            head: 'issue',
            files: [],
            totalAdditions: 0,
            totalDeletions: 0,
            fullDiff: '',
            eventType: 'issue_comment',
            isIssue: true, // Flag to indicate this is an issue, not a PR
            eventContext: context.event, // Pass the full event context
          } as any;

          // Fetch comment history for the issue
          try {
            console.log(`💬 Fetching comment history for issue #${issue.number}`);
            const comments = await analyzer.fetchPRComments(owner, repo, issue.number);
            (prInfo as any).comments = comments;
            console.log(`✅ Retrieved ${comments.length} comments for issue`);
          } catch (error) {
            console.warn(
              `⚠️ Could not fetch issue comments: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            (prInfo as any).comments = [];
          }
        }

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

        // Only run checks that are appropriate for the context
        const filteredCheckIds = checkIds.filter(checkId => {
          if (!config?.checks?.[checkId]) return false;
          const checkConfig = config.checks[checkId];
          const checkEvents = checkConfig.on || ['pr_opened', 'pr_updated'];
          // For issue comments, only run checks that are configured for issue_comment events
          if (!isPullRequest) {
            return checkEvents.includes('issue_comment');
          }
          // For PR comments, run checks configured for PR events or issue_comment
          return checkEvents.includes('pr_updated') || checkEvents.includes('issue_comment');
        });

        if (filteredCheckIds.length === 0) {
          console.log(`No checks configured to run for ${isPullRequest ? 'PR' : 'issue'} comments`);
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: `⚠️ No checks are configured to run for ${isPullRequest ? 'PR' : 'issue'} comments with command /${command.type}\n\n*Powered by [Visor](https://probelabs.com/visor)*`,
          });
          return;
        }

        const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, {
          focus,
          format,
          config: config as import('./types/config').VisorConfig,
          checks: filteredCheckIds,
          parallelExecution: false,
        });

        // Check if commenting is enabled before posting
        const shouldComment = inputs['comment-on-pr'] !== 'false';
        if (shouldComment) {
          await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
            focus,
            format,
          });
        } else {
          console.log('📝 Skipping comment (comment-on-pr is disabled)');
        }

        // Calculate total check results from grouped results
        const totalChecks = Object.values(groupedResults).flat().length;
        setOutput('checks-executed', totalChecks.toString());
      }
      break;
  }
}

async function handlePullRequestWithConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  inputs: GitHubActionInputs,
  config: import('./types/config').VisorConfig,
  checksToRun: string[],
  context: GitHubContext
): Promise<void> {
  const pullRequest = context.event?.pull_request as any;
  const action = context.event?.action as string | undefined;

  if (!pullRequest) {
    console.log('No pull request found in context');
    return;
  }

  console.log(`Reviewing PR #${pullRequest.number} with checks: ${checksToRun.join(', ')}`);

  const prNumber = pullRequest.number;
  const analyzer = new PRAnalyzer(octokit);
  const reviewer = new PRReviewer(octokit);

  // Generate comment ID for this PR
  const commentId = `pr-review-${prNumber}`;

  // Map the action to event type
  const eventType = mapGitHubEventToTrigger('pull_request', action);

  // Fetch PR diff (handle test scenarios gracefully)
  let prInfo;
  try {
    prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    // Add event context for templates and XML generation
    (prInfo as any).eventContext = context.event;
  } catch (error) {
    // Handle test scenarios with mock repos
    if (inputs['ai-provider'] === 'mock' || inputs['ai-model'] === 'mock') {
      console.log(`📋 Running in test mode with mock provider - using empty PR data`);
      setOutput('review-completed', 'true');
      setOutput('issues-found', '0');
      setOutput('checks-executed', '0');
      return;
    }
    throw error;
  }

  if (prInfo.files.length === 0) {
    console.log('⚠️ No files changed in this PR - skipping review');
    setOutput('review-completed', 'true');
    setOutput('issues-found', '0');
    return;
  }

  // Filter checks based on conditions
  const checksToExecute = await filterChecksToExecute(checksToRun, config, prInfo);

  if (checksToExecute.length === 0) {
    console.log('⚠️ No checks meet execution conditions');
    setOutput('review-completed', 'true');
    setOutput('issues-found', '0');
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
    checkResults = await createGitHubChecks(
      octokit,
      inputs,
      owner,
      repo,
      pullRequest.head?.sha || 'unknown',
      checksToExecute,
      config
    );

    if (checkResults?.checkRunMap) {
      await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);
    }
  }

  // Perform the review
  const groupedResults = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

  // Complete GitHub check runs
  if (checkResults?.checkRunMap) {
    await completeGitHubChecks(
      octokit,
      owner,
      repo,
      checkResults.checkRunMap,
      groupedResults,
      config
    );
  }

  // Post review comment (only if comment-on-pr is not disabled)
  const shouldComment = inputs['comment-on-pr'] !== 'false';
  if (shouldComment) {
    await reviewer.postReviewComment(owner, repo, prNumber, groupedResults, {
      commentId,
      triggeredBy: action,
      commitSha: pullRequest.head?.sha,
    });
  } else {
    console.log('📝 Skipping PR comment (comment-on-pr is disabled)');
  }

  // Set outputs
  setOutput('review-completed', 'true');
  setOutput('checks-executed', checksToExecute.length.toString());
  setOutput('pr-action', action);
}

async function handleRepoInfo(octokit: Octokit, owner: string, repo: string): Promise<void> {
  try {
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
  } catch {
    // Handle test scenarios or missing repos gracefully
    console.log(`📋 Running in test mode or repository not accessible: ${owner}/${repo}`);
    setOutput('repo-name', repo);
    setOutput('repo-description', 'Test repository');
    setOutput('repo-stars', '0');
  }
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

// Entry point - execute immediately when the script is run
// Note: require.main === module check doesn't work reliably with ncc bundling
// Only execute if not in test environment
if (process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined) {
  (() => {
    // Simple mode detection: use GITHUB_ACTIONS env var which is always 'true' in GitHub Actions
    // Also check for --cli flag to force CLI mode even in GitHub Actions environment
    const isGitHubAction = process.env.GITHUB_ACTIONS === 'true' && !process.argv.includes('--cli');

    if (isGitHubAction) {
      // Run as GitHub Action
      run();
    } else {
      // Import and run CLI
      import('./cli-main')
        .then(({ main }) => {
          main().catch(error => {
            console.error('CLI execution failed:', error);
            process.exit(1);
          });
        })
        .catch(error => {
          console.error('Failed to import CLI module:', error);
          process.exit(1);
        });
    }
  })();
}
