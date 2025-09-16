import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText, CommandRegistry } from './commands';
import { PRAnalyzer } from './pr-analyzer';
import { PRReviewer, calculateTotalIssues } from './reviewer';
import { ActionCliBridge, GitHubActionInputs, GitHubContext } from './action-cli-bridge';
import { CommentManager } from './github-comments';
import { ConfigManager } from './config';
import { PRDetector, GitHubEventContext } from './pr-detector';
import { GitHubCheckService, CheckRunOptions } from './github-check-service';
import { FailureConditionEvaluator } from './failure-condition-evaluator';

// Type definitions for CLI output
interface CliReviewOutput {
  overallScore?: number;
  totalIssues?: number;
  criticalIssues?: number;
  filesAnalyzed?: number | string;
  securityScore?: number;
  performanceScore?: number;
  styleScore?: number;
  architectureScore?: number;
  issues?: CliReviewIssue[];
  suggestions?: string[];
  debug?: DebugInfo;
}

interface CliReviewIssue {
  category: string;
  severity?: string;
  message: string;
  file: string;
  line: number;
  ruleId?: string;
}

interface DebugInfo {
  provider?: string;
  model?: string;
  tokensUsed?: number;
  prompt?: string;
  response?: string;
  processingTime?: number;
  parallelExecution?: boolean;
  checksExecuted?: string[];
  [key: string]: unknown;
}

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

/**
 * Post CLI review results as PR comment with robust PR detection
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function postCliReviewComment(
  cliOutput: CliReviewOutput,
  inputs: GitHubActionInputs,
  octokit: Octokit
): Promise<void> {
  try {
    const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
    const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];

    if (!owner || !repo) {
      console.log('⚠️ Missing required parameters for PR comment creation');
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

    if (!prResult.prNumber) {
      console.log(
        `⚠️ No PR found using any detection strategy: ${prResult.details || 'Unknown reason'}`
      );
      if (inputs.debug === 'true') {
        console.log('Available detection strategies:');
        prDetector.getDetectionStrategies().forEach(strategy => console.log(`  ${strategy}`));
      }
      return;
    }

    console.log(
      `✅ Found PR #${prResult.prNumber} using ${prResult.source} (confidence: ${prResult.confidence})`
    );
    if (prResult.details) {
      console.log(`   Details: ${prResult.details}`);
    }

    const commentManager = new CommentManager(octokit);

    // Create Visor-formatted comment from CLI output
    let comment = `# 🔍 Visor Code Review Results\n\n`;
    comment += `## 📊 Summary\n`;
    comment += `- **Overall Score**: ${cliOutput.overallScore || 0}/100\n`;
    comment += `- **Issues Found**: ${cliOutput.totalIssues || 0} (${cliOutput.criticalIssues || 0} Critical)\n`;
    comment += `- **Files Analyzed**: ${cliOutput.filesAnalyzed || 'N/A'}\n\n`;

    // Add category scores if available
    if (
      cliOutput.securityScore ||
      cliOutput.performanceScore ||
      cliOutput.styleScore ||
      cliOutput.architectureScore
    ) {
      comment += `## 📈 Category Scores\n`;
      if (cliOutput.securityScore !== undefined)
        comment += `- **Security**: ${cliOutput.securityScore}/100\n`;
      if (cliOutput.performanceScore !== undefined)
        comment += `- **Performance**: ${cliOutput.performanceScore}/100\n`;
      if (cliOutput.styleScore !== undefined)
        comment += `- **Style**: ${cliOutput.styleScore}/100\n`;
      if (cliOutput.architectureScore !== undefined)
        comment += `- **Architecture**: ${cliOutput.architectureScore}/100\n`;
      comment += '\n';
    }

    // Load config to determine grouping method
    const { ConfigManager } = await import('./config');
    const configManager = new ConfigManager();
    const config = await configManager.findAndLoadConfig();

    // Add issues grouped by check or category based on config
    if (cliOutput.issues && cliOutput.issues.length > 0) {
      // Always use check-based grouping when configured
      const useCheckGrouping = config.output?.pr_comment?.group_by === 'check';
      const groupedIssues = useCheckGrouping
        ? groupIssuesByCheck(cliOutput.issues)
        : groupIssuesByCategory(cliOutput.issues);

      // Get configured checks for filtering
      const configuredChecks = config.checks ? Object.keys(config.checks) : [];

      for (const [groupKey, issues] of Object.entries(groupedIssues)) {
        if (issues.length === 0) continue;

        // When using check-based grouping, only show configured checks
        if (useCheckGrouping && configuredChecks.length > 0) {
          // Skip if not a configured check (unless it's uncategorized)
          if (!configuredChecks.includes(groupKey) && groupKey !== 'uncategorized') {
            continue;
          }
        }

        const title = `${groupKey.charAt(0).toUpperCase() + groupKey.slice(1)} Issues (${issues.length})`;

        let sectionContent = '';
        for (const issue of issues.slice(0, 5)) {
          // Limit to 5 issues per category
          sectionContent += `- **${issue.severity?.toUpperCase() || 'UNKNOWN'}**: ${issue.message}\n`;
          sectionContent += `  - **File**: \`${issue.file}:${issue.line}\`\n\n`;
        }

        if (issues.length > 5) {
          sectionContent += `*...and ${issues.length - 5} more issues in this category.*\n\n`;
        }

        comment += commentManager.createCollapsibleSection(title, sectionContent, true);
        comment += '\n\n';
      }
    }

    // Add suggestions if any
    if (cliOutput.suggestions && cliOutput.suggestions.length > 0) {
      const suggestionsContent =
        cliOutput.suggestions.map((s: string) => `- ${s}`).join('\n') + '\n';
      comment += commentManager.createCollapsibleSection(
        '💡 Recommendations',
        suggestionsContent,
        true
      );
      comment += '\n\n';
    }

    // Add debug information if available
    if (cliOutput.debug) {
      const debugContent = formatDebugInfo(cliOutput.debug);
      comment +=
        '\n\n' +
        commentManager.createCollapsibleSection('🐛 Debug Information', debugContent, false);
      comment += '\n\n';
    }

    // Fetch fresh PR data to get the latest commit SHA
    let latestCommitSha: string | undefined;
    try {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prResult.prNumber,
      });
      latestCommitSha = pullRequest.head.sha;
      console.log(`📝 Latest commit SHA: ${latestCommitSha.substring(0, 7)}`);
    } catch (error) {
      console.warn('⚠️ Could not fetch latest PR data:', error);
      // Fallback to environment or event data
      latestCommitSha =
        eventContext.event?.pull_request?.head?.sha ||
        (eventContext.payload as { pull_request?: { head?: { sha?: string } } })?.pull_request?.head
          ?.sha ||
        process.env.GITHUB_SHA;
    }

    // Use smart comment updating with unique ID
    const commentId = `visor-cli-review-${prResult.prNumber}`;
    await commentManager.updateOrCreateComment(owner, repo, prResult.prNumber, comment, {
      commentId,
      triggeredBy: 'visor-cli',
      allowConcurrentUpdates: true,
      commitSha: latestCommitSha,
    });

    console.log(`✅ Posted CLI review comment to PR #${prResult.prNumber}`);
  } catch (error) {
    console.error('❌ Failed to post CLI review comment:', error);
  }
}

function groupIssuesByCategory(issues: CliReviewIssue[]): Record<string, CliReviewIssue[]> {
  const grouped: Record<string, CliReviewIssue[]> = {
    security: [],
    performance: [],
    style: [],
    logic: [],
    documentation: [],
    architecture: [],
  };

  for (const issue of issues) {
    const category = issue.category || 'logic';
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(issue);
  }

  return grouped;
}

/**
 * Group issues by the check that found them (extracted from ruleId prefix)
 */
function groupIssuesByCheck(issues: CliReviewIssue[]): Record<string, CliReviewIssue[]> {
  const grouped: Record<string, CliReviewIssue[]> = {};

  for (const issue of issues) {
    // Extract check name from ruleId prefix
    // Format: "checkName/specific-rule" -> "checkName"
    let checkName = 'uncategorized';

    if (issue.ruleId && issue.ruleId.includes('/')) {
      const parts = issue.ruleId.split('/');
      checkName = parts[0];
    }
    // No fallback to category - only use ruleId prefix

    if (!grouped[checkName]) {
      grouped[checkName] = [];
    }
    grouped[checkName].push(issue);
  }

  return grouped;
}

function formatDebugInfo(debug: DebugInfo): string {
  let content = '';
  if (debug.provider) content += `**Provider:** ${debug.provider}\n`;
  if (debug.model) content += `**Model:** ${debug.model}\n`;
  if (debug.processingTime) content += `**Processing Time:** ${debug.processingTime}ms\n`;
  if (debug.parallelExecution !== undefined)
    content += `**Parallel Execution:** ${debug.parallelExecution ? '✅' : '❌'}\n`;
  if (debug.checksExecuted) content += `**Checks Executed:** ${debug.checksExecuted.join(', ')}\n`;
  content += '\n';
  return content;
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

async function handleIssueComment(octokit: Octokit, owner: string, repo: string): Promise<void> {
  const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
  const comment = context.event?.comment;
  const issue = context.event?.issue;

  if (!comment || !issue) {
    console.log('No comment or issue found in context');
    return;
  }

  // Only process PR comments (issues with pull_request key are PRs)
  if (!issue.pull_request) {
    console.log('Comment is not on a pull request');
    return;
  }

  // Load configuration to get available commands
  const configManager = new ConfigManager();
  let config;
  const commandRegistry: CommandRegistry = {};

  try {
    config = await configManager.loadConfig('.visor.yaml');
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
    config = null;
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
      const statusPrInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
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
        const checkIds = commandRegistry[command.type];
        console.log(`Running checks for command /${command.type}: ${checkIds.join(', ')}`);

        const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);

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

        const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, {
          focus,
          format,
          config: config as import('./types/config').VisorConfig,
          checks: checkIds,
          parallelExecution: false,
        });

        await reviewer.postReviewComment(owner, repo, prNumber, review, {
          focus,
          format,
        });
        setOutput('issues-found', calculateTotalIssues(review.issues).toString());
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
  const commentManager = new CommentManager(octokit);

  // Generate comment ID for this PR to enable smart updating
  const commentId = `pr-review-${prNumber}`;

  let prInfo;
  let reviewContext = '';

  // For synchronize (new commits), get the latest commit SHA for incremental analysis
  if (action === 'synchronize') {
    const latestCommitSha = pullRequest.head?.sha;
    if (latestCommitSha) {
      console.log(`Analyzing incremental changes from commit: ${latestCommitSha}`);
      prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber, latestCommitSha);
      reviewContext =
        '## 🔄 Updated PR Analysis\n\nThis review has been updated to include the latest changes.\n\n';
    } else {
      // Fallback to full analysis if no commit SHA available
      prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
      reviewContext = '## 🔄 Updated PR Analysis\n\nAnalyzing all changes in this PR.\n\n';
    }
  } else {
    // For opened and edited events, do full PR analysis
    prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
    if (action === 'opened') {
      reviewContext =
        '## 🚀 Welcome to Automated PR Review!\n\nThis PR has been automatically analyzed. Use `/help` to see available commands.\n\n';
    } else {
      reviewContext =
        '## ✏️ PR Analysis Updated\n\nThis review has been updated based on PR changes.\n\n';
    }
  }

  // Load config for the review
  const configManager = new ConfigManager();
  let config;
  try {
    config = await configManager.loadConfig('.visor.yaml');
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
  const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

  // Complete GitHub check runs with results
  if (checkResults) {
    await completeGitHubChecks(octokit, owner, repo, checkResults.checkRunMap, review, config);
  }

  // If debug mode is enabled, output debug information to console
  if (reviewOptions.debug && review.debug) {
    console.log('\n========================================');
    console.log('🐛 DEBUG INFORMATION');
    console.log('========================================');
    console.log(`Provider: ${review.debug.provider}`);
    console.log(`Model: ${review.debug.model}`);
    console.log(`API Key Source: ${review.debug.apiKeySource}`);
    console.log(`Processing Time: ${review.debug.processingTime}ms`);
    console.log(`Prompt Length: ${review.debug.promptLength} characters`);
    console.log(`Response Length: ${review.debug.responseLength} characters`);
    console.log(`JSON Parse Success: ${review.debug.jsonParseSuccess ? '✅' : '❌'}`);
    if (review.debug.errors && review.debug.errors.length > 0) {
      console.log(`\n⚠️ Errors:`);
      review.debug.errors.forEach(err => console.log(`  - ${err}`));
    }
    console.log('\n--- AI PROMPT ---');
    console.log(review.debug.prompt.substring(0, 500) + '...');
    console.log('\n--- RAW RESPONSE ---');
    console.log(review.debug.rawResponse.substring(0, 500) + '...');
    console.log('========================================\n');
  }

  const reviewComment = await reviewer['formatReviewCommentWithVisorFormat'](review, reviewOptions);
  const fullComment = reviewContext + reviewComment;

  // Use smart comment updating - will update existing comment or create new one
  try {
    const comment = await commentManager.updateOrCreateComment(owner, repo, prNumber, fullComment, {
      commentId,
      triggeredBy: action,
      allowConcurrentUpdates: true, // Allow updates even if comment was modified externally
      commitSha: pullRequest.head?.sha,
    });

    console.log(
      `✅ ${action === 'opened' ? 'Created' : 'Updated'} PR review comment (ID: ${comment.id})`
    );
  } catch (error) {
    console.error(
      `❌ Failed to ${action === 'opened' ? 'create' : 'update'} PR review comment:`,
      error
    );

    // Fallback to creating a new comment without the smart updating
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: fullComment,
    });
    console.log('✅ Created fallback PR review comment');
  }

  // Set outputs
  setOutput('auto-review-completed', 'true');
  setOutput('issues-found', calculateTotalIssues(review.issues).toString());
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
  reviewSummary: import('./reviewer').ReviewSummary,
  config: import('./types/config').VisorConfig
): Promise<void> {
  if (!checkRunMap) return;

  const checkService = new GitHubCheckService(octokit);
  const perCheckMode = config?.output?.github_checks?.per_check !== false;

  console.log(`🏁 Completing ${checkRunMap.size} GitHub check runs...`);

  if (perCheckMode && !checkRunMap.has('combined')) {
    // Per-check mode: complete individual check runs
    await completeIndividualChecks(checkService, owner, repo, checkRunMap, reviewSummary, config);
  } else {
    // Combined mode: complete single check run with all results
    await completeCombinedCheck(checkService, owner, repo, checkRunMap, reviewSummary, config);
  }
}

/**
 * Complete individual GitHub check runs
 */
async function completeIndividualChecks(
  checkService: GitHubCheckService,
  owner: string,
  repo: string,
  checkRunMap: Map<string, { id: number; url: string }>,
  reviewSummary: import('./reviewer').ReviewSummary,
  config: import('./types/config').VisorConfig
): Promise<void> {
  // Group issues by check name
  const issuesByCheck = new Map<string, import('./types/config').Issue[]>();

  // Initialize empty arrays for all checks
  for (const checkName of checkRunMap.keys()) {
    issuesByCheck.set(checkName, []);
  }

  // Group issues by their check name (extracted from ruleId prefix)
  for (const issue of reviewSummary.issues || []) {
    if (issue.ruleId && issue.ruleId.includes('/')) {
      const checkName = issue.ruleId.split('/')[0];
      if (issuesByCheck.has(checkName)) {
        issuesByCheck.get(checkName)!.push(issue);
      }
    }
  }

  for (const [checkName, checkRun] of checkRunMap) {
    try {
      const checkIssues = issuesByCheck.get(checkName) || [];
      const checkConfig = config.checks?.[checkName];

      // Evaluate failure conditions for this specific check
      const failureResults = await evaluateCheckFailureConditions(
        config,
        checkConfig,
        checkName,
        checkIssues
      );

      await checkService.completeCheckRun(
        owner,
        repo,
        checkRun.id,
        checkName,
        failureResults,
        checkIssues
      );

      console.log(`✅ Completed ${checkName} check with ${checkIssues.length} issues`);
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
  reviewSummary: import('./reviewer').ReviewSummary,
  config: import('./types/config').VisorConfig
): Promise<void> {
  const combinedCheckRun = checkRunMap.get('combined');
  if (!combinedCheckRun) return;

  try {
    // Use all issues for the combined check
    const allIssues = reviewSummary.issues || [];

    // Evaluate global failure conditions
    const failureResults = await evaluateGlobalFailureConditions(config, allIssues);

    await checkService.completeCheckRun(
      owner,
      repo,
      combinedCheckRun.id,
      'Code Review',
      failureResults,
      allIssues
    );

    console.log(`✅ Completed combined check with ${allIssues.length} issues`);
  } catch (error) {
    console.error(`❌ Failed to complete combined check:`, error);
    await markCheckAsFailed(checkService, owner, repo, combinedCheckRun.id, 'Code Review', error);
  }
}

/**
 * Evaluate failure conditions for a specific check
 */
async function evaluateCheckFailureConditions(
  config: import('./types/config').VisorConfig,
  checkConfig: import('./types/config').CheckConfig | undefined,
  checkName: string,
  checkIssues: import('./types/config').Issue[]
): Promise<import('./types/config').FailureConditionResult[]> {
  const failureResults: import('./types/config').FailureConditionResult[] = [];
  const criticalIssues = checkIssues.filter(issue => issue.severity === 'critical').length;
  const errorIssues = checkIssues.filter(issue => issue.severity === 'error').length;

  // Check global fail_if condition
  if (config.fail_if) {
    try {
      const evaluator = new FailureConditionEvaluator();
      const reviewSummary = {
        issues: [],
        suggestions: [],
        metadata: {
          totalIssues: checkIssues.length,
          criticalIssues,
          errorIssues,
          warningIssues: 0,
          infoIssues: 0,
        },
      };

      const shouldFail = await evaluator.evaluateSimpleCondition(
        checkName,
        'legacy',
        'legacy',
        reviewSummary,
        config.fail_if
      );

      if (shouldFail) {
        failureResults.push({
          conditionName: 'global_fail_if',
          failed: true,
          severity: 'error',
          expression: config.fail_if,
          message: 'Global failure condition met',
          haltExecution: false,
        });
      }
    } catch (error) {
      console.error('❌ Failed to evaluate global fail_if condition:', config.fail_if, error);
    }
  }

  // Check check-specific fail_if condition
  if (checkConfig?.fail_if) {
    try {
      const evaluator = new FailureConditionEvaluator();
      const reviewSummary = {
        issues: [],
        suggestions: [],
        metadata: {
          totalIssues: checkIssues.length,
          criticalIssues,
          errorIssues,
          warningIssues: 0,
          infoIssues: 0,
        },
      };

      const shouldFail = await evaluator.evaluateSimpleCondition(
        checkName,
        'legacy',
        'legacy',
        reviewSummary,
        checkConfig.fail_if
      );

      if (shouldFail) {
        failureResults.push({
          conditionName: `${checkName}_fail_if`,
          failed: true,
          severity: 'error',
          expression: checkConfig.fail_if,
          message: `Check ${checkName} failure condition met`,
          haltExecution: false,
        });
      }
    } catch (error) {
      console.error(
        '❌ Failed to evaluate check-specific fail_if condition:',
        checkConfig.fail_if,
        error
      );
    }
  }

  return failureResults;
}

/**
 * Evaluate global failure conditions for combined check
 */
async function evaluateGlobalFailureConditions(
  config: import('./types/config').VisorConfig,
  allIssues: import('./types/config').Issue[]
): Promise<import('./types/config').FailureConditionResult[]> {
  const failureResults: import('./types/config').FailureConditionResult[] = [];
  const criticalIssues = allIssues.filter(issue => issue.severity === 'critical').length;
  const errorIssues = allIssues.filter(issue => issue.severity === 'error').length;

  // Check global fail_if condition
  if (config.fail_if) {
    try {
      const evaluator = new FailureConditionEvaluator();
      const reviewSummary = {
        issues: [],
        suggestions: [],
        metadata: {
          totalIssues: allIssues.length,
          criticalIssues,
          errorIssues,
          warningIssues: 0,
          infoIssues: 0,
        },
      };

      const shouldFail = await evaluator.evaluateSimpleCondition(
        'combined',
        'legacy',
        'legacy',
        reviewSummary,
        config.fail_if
      );

      if (shouldFail) {
        failureResults.push({
          conditionName: 'global_fail_if',
          failed: true,
          severity: 'error',
          expression: config.fail_if,
          message: 'Global failure condition met',
          haltExecution: false,
        });
      }
    } catch (error) {
      console.error('❌ Failed to evaluate global fail_if condition:', config.fail_if, error);
    }
  }

  return failureResults;
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

    // Fetch PR diff using GitHub API
    const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
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
    const checkResults = await createGitHubChecks(
      octokit,
      inputs,
      owner,
      repo,
      pullRequest.head.sha,
      checksToRun,
      config
    );

    // Update checks to in-progress status
    await updateChecksInProgress(octokit, owner, repo, checkResults.checkRunMap);

    // Perform the review
    console.log('🤖 Starting parallel AI review with Visor config...');
    const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

    // Update the review summary to show correct checks executed
    if (review.debug) {
      (review.debug as import('./ai-review-service').AIDebugInfo).checksExecuted = checksToRun;
      (review.debug as import('./ai-review-service').AIDebugInfo).parallelExecution = true;
    }

    // Complete GitHub check runs with results
    if (checkResults) {
      await completeGitHubChecks(octokit, owner, repo, checkResults.checkRunMap, review, config);
    }

    // Post comment using group-based comment separation
    const commentId = `visor-config-review-${prNumber}`;
    await reviewer.postReviewComment(owner, repo, prNumber, review, {
      ...reviewOptions,
      commentId,
      triggeredBy: `visor-config-${action}`,
      commitSha: pullRequest.head?.sha,
    });

    console.log('✅ Posted Visor config-based review comment');

    // Check for API errors in the review issues
    const apiErrors = review.issues.filter(
      issue =>
        issue.file === 'system' &&
        issue.severity === 'critical' &&
        (issue.message.includes('API rate limit') ||
          issue.message.includes('403') ||
          issue.message.includes('401') ||
          issue.message.includes('authentication') ||
          issue.message.includes('API key'))
    );

    if (apiErrors.length > 0) {
      console.error('🚨 Critical API errors detected in review:');
      apiErrors.forEach(error => {
        console.error(`  - ${error.message}`);
      });

      // Check if we should fail on API errors
      const failOnApiError = inputs['fail-on-api-error'] === 'true';
      if (failOnApiError) {
        setFailed(
          `Critical API errors detected: ${apiErrors.length} authentication/rate limit issues found. Please check your API credentials.`
        );
        return;
      }
    }

    // Set outputs
    setOutput('auto-review-completed', 'true');
    setOutput('issues-found', calculateTotalIssues(review.issues).toString());
    setOutput('pr-action', action || 'unknown');
    setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
    setOutput('visor-config-used', 'true');
    setOutput('checks-executed', checksToRun.join(','));
    setOutput('api-errors-found', apiErrors.length.toString());

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
