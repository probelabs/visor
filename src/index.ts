/* eslint-disable @typescript-eslint/no-explicit-any */
// GitHub event objects have complex dynamic structures that are difficult to fully type
// Using 'any' for these objects is acceptable as they come from external GitHub webhooks

// Load environment variables from .env file (override existing to allow .env to take precedence)
import * as dotenv from 'dotenv';
dotenv.config({ override: true, quiet: true });

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText, CommandRegistry } from './commands';
import { PRAnalyzer, PRInfo } from './pr-analyzer';
import { configureLoggerFromCli } from './logger';
import { deriveExecutedCheckNames } from './utils/ui-helpers';
import { GroupedCheckResults, CheckResult } from './reviewer';
import { GitHubActionInputs, GitHubContext } from './action-cli-bridge';
import { ConfigManager } from './config';
import { ReactionManager } from './github-reactions';
import { generateFooter, hasVisorFooter } from './footer';
import { extractTextFromJson } from './utils/json-text-extractor';

/**
 * Create an authenticated Octokit instance using either GitHub App || token authentication
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

      // Validate && parse the installation ID if provided
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
              '⚠️ Could not auto-detect installation ID. Please check app permissions && installation status.'
            );
            throw new Error(
              'GitHub App installation ID is required but could not be auto-detected. Please ensure the app is installed on this repository || provide the `installation-id` manually.'
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
        '❌ GitHub App authentication failed. Please check your App ID, Private Key, && installation permissions.'
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

  throw new Error('Either github-token || app-id/private-key must be provided for authentication');
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
      'add-reactions': getInput('add-reactions') || undefined,
      'fail-on-critical': getInput('fail-on-critical') || undefined,
      'fail-on-api-error': getInput('fail-on-api-error') || undefined,
      'min-score': getInput('min-score') || undefined,
      'max-parallelism': getInput('max-parallelism') || undefined,
      'ai-provider': getInput('ai-provider') || undefined,
      'ai-model': getInput('ai-model') || undefined,
      // Tag filtering inputs
      tags: getInput('tags') || undefined,
      'exclude-tags': getInput('exclude-tags') || undefined,
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

    // Configure logger level early so engine/info/debug logs appear in Actions
    try {
      const debugEnabled = String(inputs.debug || '').toLowerCase() === 'true';
      configureLoggerFromCli({ debug: debugEnabled, output: 'table' });
    } catch {}

    // Always use config-driven mode in GitHub Actions
    // The CLI mode is only for local development, not for GitHub Actions
    console.log('🤖 Using config-driven mode');
    // Version banner for Action runs (mirrors CLI banner but via console)
    try {
      const visorVersion =
        process.env.VISOR_VERSION || (require('../package.json')?.version ?? 'dev');
      const commitShort = process.env.VISOR_COMMIT_SHORT || '';
      let probeVersion = process.env.PROBE_VERSION || 'unknown';
      if (!process.env.PROBE_VERSION) {
        try {
          probeVersion = require('@probelabs/probe/package.json')?.version ?? 'unknown';
        } catch {}
      }
      const visorPart = commitShort ? `${visorVersion} (${commitShort})` : visorVersion;
      console.log(`ℹ️ Visor ${visorPart} • Probe ${probeVersion} • Node ${process.version}`);
    } catch {}

    // Load config to determine which checks should run for this event
    const configManager = new ConfigManager();
    let config: import('./types/config').VisorConfig;

    // First try to load user config, then fall back to defaults/visor.yaml
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
        // Ultimate fallback if even defaults/visor.yaml can't be loaded
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
        console.log('⚠️ Could not load defaults/visor.yaml, using minimal configuration');
      }
    }

    // Enable GitHub frontend by default only for PR contexts in Actions
    // For issue events we post a single summary comment at the end to avoid noise
    try {
      const isPRContext =
        eventName === 'pull_request' ||
        eventName === 'pull_request_target' ||
        Boolean((context.event as any)?.issue?.pull_request);
      if (isPRContext) {
        const cfg: any = JSON.parse(JSON.stringify(config));
        const fronts = Array.isArray(cfg.frontends) ? cfg.frontends : [];
        if (!fronts.some((f: any) => f && f.name === 'github')) fronts.push({ name: 'github' });
        cfg.frontends = fronts;
        (config as any) = cfg;
      }
    } catch {}

    // Determine AI provider overrides && fallbacks for issue flows
    const hasAnyAIKey = Boolean(
      process.env.GOOGLE_API_KEY ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
        process.env.AWS_BEDROCK_API_KEY
    );
    // Honor Action inputs if provided
    if (inputs['ai-provider']) {
      (config as any).ai_provider = inputs['ai-provider'];
    }
    if (inputs['ai-model']) {
      (config as any).ai_model = inputs['ai-model'];
    }
    // If no keys && no explicit provider/model, fall back to mock to ensure assistants produce output
    if (!hasAnyAIKey && !(config as any).ai_provider && !(config as any).ai_model) {
      (config as any).ai_provider = 'mock';
      (config as any).ai_model = 'mock';
      console.log('🎭 No AI API key detected; using mock AI provider for assistant checks');
    }

    // Diagnostics: show how AI provider will be resolved for this run (no secrets)
    try {
      const hasAnyAIKey = Boolean(
        process.env.GOOGLE_API_KEY ||
          process.env.ANTHROPIC_API_KEY ||
          process.env.OPENAI_API_KEY ||
          (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
          process.env.AWS_BEDROCK_API_KEY
      );
      const resolvedProvider = (config as any).ai_provider || inputs['ai-provider'] || 'auto';
      const resolvedModel = (config as any).ai_model || inputs['ai-model'] || 'auto';
      console.log(
        `🔎 AI resolved: provider=${resolvedProvider}, model=${resolvedModel}, keyPresent=${hasAnyAIKey ? 'yes' : 'no'}`
      );
    } catch {}

    // Determine which event we're handling && run appropriate checks
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
        'Set CLAUDE_CODE_API_KEY || ANTHROPIC_API_KEY in your GitHub secrets.',
      ].join(' ');
      setFailed(errorMessage);
    } else if (error instanceof Error && error.message.includes('No API key configured')) {
      const errorMessage = [
        'No API key || credentials configured for AI provider.',
        'Set one of the following in GitHub secrets:',
        'GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY,',
        'or AWS credentials (AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY).',
      ].join(' ');
      setFailed(errorMessage);
    } else {
      setFailed(error instanceof Error ? error.message : 'Unknown error');
    }
  } finally {
    // Cleanup AI sessions before GitHub Action exits to prevent process hanging
    const { SessionRegistry } = await import('./session-registry');
    const sessionRegistry = SessionRegistry.getInstance();
    if (sessionRegistry.getActiveSessionIds().length > 0) {
      console.log(
        `🧹 Cleaning up ${sessionRegistry.getActiveSessionIds().length} active AI sessions...`
      );
      sessionRegistry.clearAllSessions();
    }
  }
}

// Helper: derive the list of executed checks from grouped results
// Re-export for tests (avoid importing full index in unit tests)
export { deriveExecutedCheckNames };

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
 * Resolve the PR head SHA for contexts like issue_comment where payload may not include head.sha.
 * Falls back to a pulls.get API call when needed.
 */
// Head SHA helper moved to utils/head-sha to simplify testing/imports

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

  // Determine context type for better logging
  const isPullRequest = eventName === 'pull_request';
  const isIssue = eventName === 'issues';
  const isIssueComment = eventName === 'issue_comment';
  const isManualCLI = !eventName || eventName === 'unknown';

  // Map GitHub event to our event trigger format
  const eventType = mapGitHubEventToTrigger(eventName, context.event?.action);

  // Enhanced event logging with context
  if (isManualCLI) {
    console.log(`🖥️  Mode: Manual CLI`);
    console.log(`📂 Repository: ${owner}/${repo}`);
  } else {
    console.log(`🤖 Mode: GitHub Action`);
    console.log(`📂 Repository: ${owner}/${repo}`);
    console.log(
      `📋 Event: ${eventName}${context.event?.action ? ` (action: ${context.event?.action})` : ''}`
    );
    console.log(`🎯 Trigger: ${eventType}`);

    // Show context-specific information
    if (isPullRequest) {
      const prNumber = context.event?.pull_request?.number;
      console.log(`🔀 Context: Pull Request #${prNumber}`);
    } else if (isIssue) {
      const issueNumber = context.event?.issue?.number;
      console.log(`🎫 Context: Issue #${issueNumber}`);
    } else if (isIssueComment) {
      const issueOrPR = context.event?.issue;
      const isPR = issueOrPR?.pull_request ? true : false;
      const number = issueOrPR?.number;
      console.log(`💬 Context: Comment on ${isPR ? 'Pull Request' : 'Issue'} #${number}`);
    }
  }

  // Debug: Log the checks that are available in the loaded config
  const allChecks = Object.keys(config.checks || {});
  console.log(`📚 Total checks in loaded config: ${allChecks.length}`);
  if (allChecks.length <= 10) {
    // Only log check names if there aren't too many
    console.log(`📚 Available checks: ${allChecks.join(', ')}`);
  }

  // Find checks that should run for this event
  let checksToRun: string[] = [];

  // First, get all checks that are configured for this event type
  const eventChecks: string[] = [];
  for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
    // Check if this check should run for this event
    // If 'on' is not specified, the check can run on any event
    if (!checkConfig.on || checkConfig.on.includes(eventType)) {
      eventChecks.push(checkName);
    }
  }

  // Now apply the 'checks' input filter if provided
  const checksInput = inputs.checks || inputs['visor-checks'];
  if (checksInput && checksInput.trim() !== '') {
    const requestedChecks = checksInput.split(',').map((c: string) => c.trim());

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
  console.log(`🐛 DEBUG-VERSION-999: About to create ReactionManager`);

  // Check if reactions are enabled (default: true)
  const reactionsEnabled = inputs['add-reactions'] !== 'false';
  console.log(`🔔 Reactions ${reactionsEnabled ? 'enabled' : 'disabled'}`);

  // Create reaction manager for emoji reactions
  const reactionManager = new ReactionManager(octokit);
  console.log(`🐛 DEBUG: ReactionManager created successfully`);

  // Define comment interface for type safety
  interface CommentLike {
    id?: number;
    user?: { login?: string; type?: string };
    body?: string;
  }

  // Check if this is a bot comment that we should skip
  const comment: CommentLike | undefined = context.event?.comment;
  const shouldSkipBotComment =
    comment &&
    (comment.user?.login === 'visor[bot]' ||
      comment.user?.login === 'github-actions[bot]' ||
      comment.user?.type === 'Bot' ||
      (comment.body && comment.body.includes('<!-- visor-comment-id:')));

  // Extract context for reactions
  // Note: Type assertions are necessary because GitHub context types are not well-defined
  // && TypeScript infers these as 'unknown' without explicit casting
  const reactionContext: {
    eventName: string;
    issueNumber?: number;
    commentId?: number;
  } = {
    eventName: eventName || 'unknown',
    issueNumber: (context.event?.pull_request?.number || context.event?.issue?.number) as
      | number
      | undefined,
    // Only set commentId if it's not a bot comment
    commentId: shouldSkipBotComment
      ? undefined
      : (context.event?.comment?.id as number | undefined),
  };

  // Debug logging for reactions
  console.log(
    `🔍 Reaction context: issueNumber=${reactionContext.issueNumber}, commentId=${reactionContext.commentId}, shouldSkipBot=${shouldSkipBotComment}, commentUser=${comment?.user?.login}`
  );

  // Add acknowledgement reaction (eye emoji) at the start && store the reaction ID
  // Skip reactions for bot comments to avoid recursion
  let acknowledgementReactionId: number | null = null;
  if (reactionsEnabled && (reactionContext.issueNumber || reactionContext.commentId)) {
    acknowledgementReactionId = await reactionManager.addAcknowledgementReaction(
      owner,
      repo,
      reactionContext
    );
  } else if (!reactionsEnabled) {
    console.log('⚠️  Reactions disabled - skipping acknowledgement reaction');
  } else {
    console.log('⚠️  No reaction added - neither issueNumber nor commentId available');
  }

  try {
    // Handle different GitHub events
    switch (eventName) {
      case 'issue_comment':
        await handleIssueComment(octokit, owner, repo, context, inputs, config, checksToRun);
        break;
      case 'pull_request':
        // Run the checks that are configured for this event
        await handlePullRequestWithConfig(
          octokit,
          owner,
          repo,
          inputs,
          config,
          checksToRun,
          context
        );
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
  } finally {
    // Add completion reaction (thumbs up emoji) after processing
    if (reactionsEnabled && (reactionContext.issueNumber || reactionContext.commentId)) {
      await reactionManager.addCompletionReaction(owner, repo, {
        ...reactionContext,
        acknowledgementReactionId,
      });
    }
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
    // Normalize depends_on to array (supports string | string[])
    const rawDeps = checkConfig?.depends_on;
    const depsArray = Array.isArray(rawDeps) ? rawDeps : rawDeps ? [rawDeps] : [];
    // Expand OR groups (pipe syntax) for dependency closure discovery
    const dependencies = depsArray.flatMap((d: string) =>
      typeof d === 'string' && d.includes('|')
        ? d
            .split('|')
            .map(s => s.trim())
            .filter(Boolean)
        : [d]
    );

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
 * Resolve downstream dependents for a set of checks (reverse dependency closure).
 * If A is in starts && B depends_on A, include B. Recurse transitively.
 */
// (Intentionally no reverse-dependent resolution here.)

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
    `📋 Processing issue #${issue.number} event: ${action} with ${checksToRun.length} check(s): ${checksToRun.join(', ')}`
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

  // Run the checks using StateMachineExecutionEngine
  const engine = new (await import('./state-machine-execution-engine')).StateMachineExecutionEngine(
    undefined,
    octokit
  );
  try {
    (engine as any).setExecutionContext?.({ octokit });
  } catch {}

  try {
    // Build tag filter from action inputs (if provided)
    const tagFilter: import('./types/config').TagFilter | undefined =
      (inputs.tags && inputs.tags.trim() !== '') ||
      (inputs['exclude-tags'] && inputs['exclude-tags']!.trim() !== '')
        ? {
            include: inputs.tags
              ? inputs.tags
                  .split(',')
                  .map((t: string) => t.trim())
                  .filter(Boolean)
              : undefined,
            exclude: inputs['exclude-tags']
              ? inputs['exclude-tags']
                  .split(',')
                  .map((t: string) => t.trim())
                  .filter(Boolean)
              : undefined,
          }
        : undefined;

    const executionResult = await engine.executeGroupedChecks(
      prInfo,
      checksToRun,
      undefined, // timeout
      config,
      undefined, // outputFormat
      inputs.debug === 'true',
      undefined,
      undefined,
      tagFilter
    );

    const { results } = executionResult;

    // Log execution results for debugging (only in debug mode)
    if (inputs.debug === 'true') {
      console.log(`📊 Check execution completed: ${Object.keys(results).length} group(s)`);
      for (const [group, checks] of Object.entries(results)) {
        console.log(`   Group "${group}": ${checks.length} check(s)`);
        for (const check of checks) {
          const hasContent = check.content && check.content.trim();
          const contentLength = hasContent ? check.content.trim().length : 0;
          const issueCount = check.issues?.length || 0;
          console.log(
            `      - ${check.checkName}: ${hasContent ? `${contentLength} chars` : 'empty'}, ${issueCount} issue(s)`
          );
        }
      }
    }

    // Format && post results as a comment on the issue
    if (Object.keys(results).length > 0) {
      let commentBody = '';

      // Collapse dynamic group: if multiple dynamic responses exist in a single run,
      // take only the last non-empty one to avoid duplicated old+new answers.
      const resultsToUse: GroupedCheckResults = { ...results };
      try {
        const dyn: CheckResult[] | undefined = resultsToUse['dynamic'];
        if (Array.isArray(dyn) && dyn.length > 1) {
          const nonEmpty = dyn.filter(d => d.content && d.content.trim().length > 0);
          if (nonEmpty.length > 0) {
            // Keep only the last non-empty dynamic item
            resultsToUse['dynamic'] = [nonEmpty[nonEmpty.length - 1]];
          } else {
            // All empty: keep the last item (empty) to preserve intent
            resultsToUse['dynamic'] = [dyn[dyn.length - 1]];
          }
        }
      } catch (error) {
        console.warn(
          'Failed to collapse dynamic group:',
          error instanceof Error ? error.message : String(error)
        );
      }

      // Directly use check content without adding extra headers
      for (const checks of Object.values(resultsToUse)) {
        for (const check of checks) {
          // Try to get content, with fallback to output.text (for custom schemas like issue-assistant)
          let content = check.content?.trim();
          // If content looks like JSON with a text field, extract it
          if (content) {
            const extracted = extractTextFromJson(content);
            if (extracted) {
              content = extracted;
            }
          }
          if (!content && check.output) {
            const out = check.output as any;
            if (typeof out === 'string' && out.trim()) {
              // Check if string output is JSON with text field
              const extracted = extractTextFromJson(out.trim());
              content = extracted || out.trim();
            } else if (typeof out === 'object') {
              const txt = out.text || out.response || out.message;
              if (typeof txt === 'string' && txt.trim()) {
                content = txt.trim();
              }
            }
          }

          if (content) {
            commentBody += `${content}\n\n`;
          }
        }
      }

      // Only post if there's actual content (not just empty checks)
      if (commentBody.trim()) {
        // Only add footer if not already present (to avoid duplicates)
        if (!hasVisorFooter(commentBody)) {
          commentBody += `\n${generateFooter()}`;
        }

        // Post comment to the issue
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issue.number,
          body: commentBody,
        });

        console.log(`✅ Posted issue assistant results to issue #${issue.number}`);
      } else {
        // No content to post. Before exiting quietly, surface any rendering/critical errors
        // that occurred during execution so users can see what went wrong.
        try {
          const errorLines: string[] = [];
          for (const checks of Object.values(results)) {
            for (const check of checks) {
              for (const issue of check.issues || []) {
                const id = String(issue.ruleId || '');
                const sev = String((issue as any).severity || '');
                const isRenderError = id.endsWith('/render-error');
                const isError =
                  isRenderError || sev === 'error' || sev === 'critical' || id.endsWith('/error');
                if (isError) {
                  errorLines.push(`   - [${check.checkName}] ${id}: ${issue.message}`);
                }
              }
            }
          }
          if (errorLines.length > 0) {
            console.error(
              '❌ No content to post. Errors encountered during check rendering/execution:'
            );
            for (const line of errorLines.slice(0, 50)) console.error(line);
            if (errorLines.length > 50) console.error(`   ... and ${errorLines.length - 50} more`);
          }
        } catch {}
        // Guarded re-run: if assistant produced no content && there were no errors, retry issue-assistant with mock provider
        try {
          const hadErrors = Object.values(results).some(arr =>
            (arr as any[]).some(ch =>
              (ch.issues || []).some(
                (iss: { severity?: string; ruleId?: string }) =>
                  (iss.severity === 'error' || iss.severity === 'critical') &&
                  !String(iss.ruleId || '').endsWith('/__skipped')
              )
            )
          );
          const hadAssistant = Object.values(results).some(arr =>
            (arr as any[]).some(ch => ch.checkName === 'issue-assistant')
          );
          if (hadAssistant && !hadErrors) {
            console.log(
              '🛡️  Guard: issue-assistant produced no content; re-running with mock provider'
            );
            const rerunConfig: any = { ...(config as any), ai_provider: 'mock', ai_model: 'mock' };
            const rerun = await engine.executeGroupedChecks(
              prInfo,
              ['issue-assistant'],
              undefined,
              rerunConfig,
              undefined,
              inputs.debug === 'true'
            );
            const rerunResults: any = rerun.results || {};
            let rerunBody = '';
            for (const checks of Object.values(rerunResults) as any[]) {
              for (const check of checks as any[]) {
                if (check.content && String(check.content).trim()) {
                  rerunBody += `${String(check.content).trim()}

`;
                }
              }
            }
            if (rerunBody.trim()) {
              if (!hasVisorFooter(rerunBody))
                rerunBody += `
${generateFooter()}`;
              await octokit.rest.issues.createComment({
                owner,
                repo,
                issue_number: issue.number,
                body: rerunBody,
              });
              console.log(
                `✅ Posted issue assistant (guarded rerun) results to issue #${issue.number}`
              );
            } else {
              console.log('ℹ️ Guarded rerun produced no content');
            }
          }
        } catch (e) {
          console.warn('⚠️ Guarded rerun failed:', e instanceof Error ? e.message : String(e));
        }
        console.log('ℹ️ No content to post - all checks returned empty results');
      }
    } else {
      console.log('⚠️ No results from issue assistant checks');
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
    console.log('No comment || issue found in context');
    return;
  }

  // Prevent recursion: skip if comment is from visor itself
  // Check both comment author && content markers
  const isVisorBot =
    comment.user?.login === 'visor[bot]' ||
    comment.user?.login === 'github-actions[bot]' ||
    comment.user?.type === 'Bot';

  const hasVisorMarkers =
    comment.body &&
    (comment.body.includes('<!-- visor-comment-id:') || hasVisorFooter(comment.body));

  if (isVisorBot || hasVisorMarkers) {
    console.log(
      `✓ Skipping bot's own comment to prevent recursion. Author: ${comment.user?.login}, Type: ${comment.user?.type}, Has markers: ${hasVisorMarkers}`
    );
    return;
  }

  // Process comments on both issues && PRs
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
    commandRegistry['review'] = ['security', 'performance', 'architecture'];
  }

  // Parse comment with available commands
  const availableCommands = Object.keys(commandRegistry);
  const command = parseComment(comment.body, availableCommands);
  if (!command) {
    console.log('No valid command found in comment');
    // For issue comments (not PRs), run event-driven checks instead of command-based logic
    // This allows checks with `on: [issue_comment]` to execute based on their `if` conditions
    if (!isPullRequest && _actionChecksToRun && _actionChecksToRun.length > 0 && config) {
      console.log(
        '📋 No command found, but this is an issue comment - running event-driven checks'
      );
      // Run the checks that were determined by the main run() function
      await handleIssueEvent(octokit, owner, repo, context, inputs, config, _actionChecksToRun);
    }
    // For PRs without commands, || issues without checks to run, return early
    return;
  }

  console.log(`Processing command: ${command.type}`);

  const prNumber = issue.number;
  const analyzer = new PRAnalyzer(octokit);
  // Commands are handled by engine + frontends; PRReviewer is deprecated

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
          `\n${generateFooter()}`;

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
          `\n${generateFooter()}`;

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
        // Resolve only upstream dependencies. Downstream steps should be invoked via goto routing if needed.
        const checkIds = resolveDependencies(initialCheckIds, config);
        console.log(
          `Running checks for command /${command.type} (initial: ${initialCheckIds.join(', ')}, resolved: ${checkIds.join(', ')})`
        );

        // Different handling for PRs vs Issues
        let prInfo: PRInfo;
        if (isPullRequest) {
          // It's a PR comment - fetch the PR diff
          prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, 'issue_comment');
          // Add event context for templates && XML generation
          (prInfo as any).eventContext = context.event;
          // PR context always includes code diffs
          (prInfo as any).includeCodeContext = true;
          (prInfo as any).isPRContext = true;
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
        const focus = command.args?.find(arg => arg.startsWith('--focus='))?.split('=')[1];
        // Deprecated: format is no longer used in command path; frontends handle rendering

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
          // If 'on' is not specified, the check can run on any event
          if (!checkConfig.on) {
            return true;
          }
          // For issue comments, only run checks that are configured for issue_comment events
          if (!isPullRequest) {
            return checkConfig.on.includes('issue_comment');
          }
          // For PR comments, run checks configured for PR events || issue_comment
          return checkConfig.on.includes('pr_updated') || checkConfig.on.includes('issue_comment');
        });

        if (filteredCheckIds.length === 0) {
          console.log(`No checks configured to run for ${isPullRequest ? 'PR' : 'issue'} comments`);
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: `⚠️ No checks are configured to run for ${isPullRequest ? 'PR' : 'issue'} comments with command /${command.type}\n\n${generateFooter()}`,
          });
          return;
        }

        // Run via state-machine + frontends (checks + grouped comments handled by frontend)
        const engine = new (
          await import('./state-machine-execution-engine')
        ).StateMachineExecutionEngine(undefined, octokit);
        try {
          (engine as any).setExecutionContext?.({ octokit });
        } catch {}
        const cfgAny: any = JSON.parse(JSON.stringify(config));
        const fronts = Array.isArray(cfgAny.frontends) ? cfgAny.frontends : [];
        if (!fronts.some((f: any) => f && f.name === 'github')) fronts.push({ name: 'github' });
        cfgAny.frontends = fronts;

        const exec = await engine.executeGroupedChecks(
          prInfo,
          filteredCheckIds,
          undefined,
          cfgAny,
          undefined,
          String(inputs.debug || '').toLowerCase() === 'true'
        );
        const totalChecks = Object.values(exec.results).flatMap(checks => checks).length;
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
  context: GitHubContext,
  _githubV2_unused?: boolean
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
  // Deprecated: PRReviewer not used in PR auto-review path

  // Deprecated: legacy comment ID no longer used; frontends manage threads

  // Map the action to event type
  const eventType = mapGitHubEventToTrigger('pull_request', action);

  // Fetch PR diff (handle test scenarios gracefully)
  // In PR context, ALWAYS include full diffs for proper code review
  console.log('📝 Code context: ENABLED (PR context - always included)');
  let prInfo;
  try {
    prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, eventType);
    // Add event context for templates && XML generation
    (prInfo as any).eventContext = context.event;
    // Mark that we're in PR context && should always include diffs
    (prInfo as any).includeCodeContext = true;
    (prInfo as any).isPRContext = true;
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

  // Default path: run state-machine engine with event-bus frontends
  {
    const engine = new (
      await import('./state-machine-execution-engine')
    ).StateMachineExecutionEngine(undefined, octokit);
    try {
      (engine as any).setExecutionContext?.({ octokit });
    } catch {}

    // Ensure frontends include github (may already be injected earlier)
    const cfgAny: any = JSON.parse(JSON.stringify(config));
    const fronts = Array.isArray(cfgAny.frontends) ? cfgAny.frontends : [];
    if (!fronts.some((f: any) => f && f.name === 'github')) fronts.push({ name: 'github' });
    cfgAny.frontends = fronts;

    await engine.executeGroupedChecks(
      prInfo,
      checksToExecute,
      undefined,
      cfgAny,
      undefined,
      inputs.debug === 'true'
    );

    setOutput('review-completed', 'true');
    setOutput('checks-executed', checksToExecute.length.toString());
    setOutput('pr-action', action);
    return;
  }

  // Legacy reviewer/comment path removed; handled above by engine + frontends
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
    // Handle test scenarios || missing repos gracefully
    console.log(`📋 Running in test mode || repository not accessible: ${owner}/${repo}`);
    setOutput('repo-name', repo);
    setOutput('repo-description', 'Test repository');
    setOutput('repo-stars', '0');
  }
}

/**
 * Filter checks based on their if conditions && API requirements
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
// Legacy GitHub check helpers removed; GitHub frontend manages Check Runs

// Legacy content-parsing helper removed. GitHub frontend now maps issues directly
// from structured outputs; no need to parse rendered text.

/**
 * Complete individual GitHub check runs
 */
/*async function completeIndividualChecks(
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

  // Extract all issues once && group by check name for O(N) complexity
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

      // Get global && check-specific fail_if conditions
      const globalFailIf = config?.fail_if;
      const checkFailIf = config?.checks?.[checkName]?.fail_if;

      // Create a ReviewSummary for this check's issues
      const checkReviewSummary = {
        issues: checkIssues,
      };

      // Determine which fail_if to use: check-specific overrides global
      const effectiveFailIf = checkFailIf || globalFailIf;

      if (effectiveFailIf) {
        const failed = await failureEvaluator.evaluateSimpleCondition(
          checkName,
          typeof config?.checks?.[checkName]?.schema === 'object'
            ? 'custom'
            : config?.checks?.[checkName]?.schema || 'plain',
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
}*/

/**
 * Complete combined GitHub check run
 */
/*async function completeCombinedCheck(
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
}*/

// Legacy markCheckAsFailed removed; Check Service completion handled in frontend.

// Entry point - execute immediately when the script is run
// Note: require.main === module check doesn't work reliably with ncc bundling
// Only execute if not in test environment
// Allow forcing the entrypoint under Jest via VISOR_E2E_FORCE_RUN=true
if (
  process.env.VISOR_E2E_FORCE_RUN === 'true' ||
  (process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID === undefined)
) {
  (async () => {
    // Explicit mode selection: --mode flag (or --cli) > Action input 'mode' > default 'cli'.
    // This avoids relying on GITHUB_ACTIONS heuristics.
    const argv = process.argv.slice(2);
    const modeFromFlagEq = argv.find(a => a.startsWith('--mode='))?.split('=')[1];
    const modeIdx = argv.indexOf('--mode');
    const modeFromFlag = modeFromFlagEq || (modeIdx >= 0 ? argv[modeIdx + 1] : undefined);
    const shorthandCli = argv.includes('--cli');
    let modeFromInput = '';
    try {
      modeFromInput = getInput('mode') || '';
    } catch {}
    const mode = (modeFromFlag || (shorthandCli ? 'cli' : '') || modeFromInput || 'cli')
      .toString()
      .toLowerCase();

    if (mode === 'github-actions' || mode === 'github') {
      // Run in GitHub Action mode explicitly && await completion to avoid early exit
      try {
        await run();
      } catch (error) {
        console.error('GitHub Action execution failed:', error);
        // Prefer failing the action explicitly if available
        try {
          const { setFailed } = await import('@actions/core');
          setFailed(error instanceof Error ? error.message : String(error));
        } catch {}
        process.exit(1);
      }
    } else {
      // Default to CLI mode
      try {
        const { main } = await import('./cli-main');
        await main();
      } catch (error) {
        console.error('CLI execution failed:', error);
        process.exit(1);
      }
    }
  })();
}
