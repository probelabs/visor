import { Octokit } from '@octokit/rest';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText } from './commands';
import { PRAnalyzer } from './pr-analyzer';
import { PRReviewer, calculateOverallScore, calculateTotalIssues } from './reviewer';
import { ActionCliBridge, GitHubActionInputs, GitHubContext } from './action-cli-bridge';
import { CommentManager } from './github-comments';
import { ConfigManager } from './config';

export async function run(): Promise<void> {
  try {
    const token = getInput('github-token', { required: true });
    const octokit = new Octokit({ auth: token });

    // Collect all GitHub Action inputs
    const inputs: GitHubActionInputs = {
      'github-token': token,
      owner: getInput('owner') || process.env.GITHUB_REPOSITORY_OWNER,
      repo: getInput('repo') || process.env.GITHUB_REPOSITORY?.split('/')[1],
      'auto-review': getInput('auto-review'),
      debug: getInput('debug'),
      // Only collect other inputs if they have values to avoid triggering CLI mode
      checks: getInput('checks') || undefined,
      'output-format': getInput('output-format') || undefined,
      'config-path': getInput('config-path') || undefined,
      'comment-on-pr': getInput('comment-on-pr') || undefined,
      'create-check': getInput('create-check') || undefined,
      'add-labels': getInput('add-labels') || undefined,
      'fail-on-critical': getInput('fail-on-critical') || undefined,
      'min-score': getInput('min-score') || undefined,
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

      // CRITICAL FIX: For PR auto-reviews, use GitHub API instead of CLI for accurate diff analysis
      const isAutoPRReview = inputs['auto-review'] === 'true' && eventName === 'pull_request';
      if (isAutoPRReview) {
        console.log(
          '🔄 PR Auto-review detected - using GitHub API instead of CLI for accurate diff analysis'
        );
        await handlePullRequestVisorMode(inputs, context);
        return;
      }

      await handleVisorMode(cliBridge, inputs, context);
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
  _context: GitHubContext
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
        outputs['overall-score'] = cliOutput.overallScore?.toString() || '0';
        outputs['total-issues'] = cliOutput.totalIssues?.toString() || '0';
        outputs['critical-issues'] = cliOutput.criticalIssues?.toString() || '0';
        outputs['security-score'] = cliOutput.securityScore?.toString() || '100';
        outputs['performance-score'] = cliOutput.performanceScore?.toString() || '100';
        outputs['style-score'] = cliOutput.styleScore?.toString() || '100';
        outputs['architecture-score'] = cliOutput.architectureScore?.toString() || '100';
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
 * Post CLI review results as PR comment
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function postCliReviewComment(cliOutput: any, inputs: GitHubActionInputs): Promise<void> {
  try {
    const token = inputs['github-token'];
    const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
    const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];

    if (!owner || !repo || !token) {
      console.log('⚠️ Missing required parameters for PR comment creation');
      return;
    }

    // Get PR number from GitHub context
    const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
    const prNumber = context.event?.pull_request?.number;

    if (!prNumber) {
      console.log('⚠️ No PR number found in GitHub context');
      return;
    }

    const octokit = new Octokit({ auth: token });
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

    // Add issues grouped by category
    if (cliOutput.issues && cliOutput.issues.length > 0) {
      const groupedIssues = groupIssuesByCategory(cliOutput.issues);

      for (const [category, issues] of Object.entries(groupedIssues)) {
        if (issues.length === 0) continue;

        const emoji = getCategoryEmoji(category);
        const title = `${emoji} ${category.charAt(0).toUpperCase() + category.slice(1)} Issues (${issues.length})`;

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
      comment += commentManager.createCollapsibleSection(
        '🐛 Debug Information',
        debugContent,
        false
      );
      comment += '\n\n';
    }

    // Use smart comment updating with unique ID
    const commentId = `visor-cli-review-${prNumber}`;
    await commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
      commentId,
      triggeredBy: 'visor-cli',
      allowConcurrentUpdates: true,
    });

    console.log('✅ Posted CLI review comment to PR');
  } catch (error) {
    console.error('❌ Failed to post CLI review comment:', error);
  }
}

function groupIssuesByCategory(issues: any[]): Record<string, any[]> {
  const grouped: Record<string, any[]> = {
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

function getCategoryEmoji(category: string): string {
  const emojiMap: Record<string, string> = {
    security: '🔒',
    performance: '📈',
    style: '🎨',
    logic: '🧠',
    documentation: '📚',
    architecture: '🏗️',
  };
  return emojiMap[category] || '📝';
}

function formatDebugInfo(debug: any): string {
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

  const command = parseComment(comment.body);
  if (!command) {
    console.log('No valid command found in comment');
    return;
  }

  console.log(`Processing command: ${command.type}`);

  const prNumber = issue.number;
  const analyzer = new PRAnalyzer(octokit);
  const reviewer = new PRReviewer(octokit);

  switch (command.type) {
    case 'review':
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

      console.log(`Starting PR review for #${prNumber}`);
      const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
      const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, { focus, format });

      await reviewer.postReviewComment(owner, repo, prNumber, review, { focus, format });

      setOutput('review-score', calculateOverallScore(review.issues).toString());
      setOutput('issues-found', calculateTotalIssues(review.issues).toString());
      break;

    case 'status':
      const statusPrInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
      const statusComment =
        `## 📊 PR Status\n\n` +
        `**Title:** ${statusPrInfo.title}\n` +
        `**Author:** ${statusPrInfo.author}\n` +
        `**Files Changed:** ${statusPrInfo.files.length}\n` +
        `**Additions:** +${statusPrInfo.totalAdditions}\n` +
        `**Deletions:** -${statusPrInfo.totalDeletions}\n` +
        `**Base:** ${statusPrInfo.base} → **Head:** ${statusPrInfo.head}`;

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
        body: getHelpText(),
      });
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

  // Create review options, including debug if enabled
  const reviewOptions = {
    debug: inputs?.debug === 'true',
  };

  // Perform the review with debug options
  const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

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

  const reviewComment = reviewer['formatReviewCommentWithVisorFormat'](review, reviewOptions);
  const fullComment = reviewContext + reviewComment;

  // Use smart comment updating - will update existing comment or create new one
  try {
    const comment = await commentManager.updateOrCreateComment(owner, repo, prNumber, fullComment, {
      commentId,
      triggeredBy: action,
      allowConcurrentUpdates: true, // Allow updates even if comment was modified externally
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
  setOutput('review-score', calculateOverallScore(review.issues).toString());
  setOutput('issues-found', calculateTotalIssues(review.issues).toString());
  setOutput('pr-action', action);
  setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
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
 * Handle PR review using Visor config but with proper GitHub API PR diff analysis
 */
async function handlePullRequestVisorMode(
  inputs: GitHubActionInputs,
  _context: GitHubContext
): Promise<void> {
  const token = inputs['github-token'];
  const owner = inputs.owner || process.env.GITHUB_REPOSITORY_OWNER;
  const repo = inputs.repo || process.env.GITHUB_REPOSITORY?.split('/')[1];

  if (!owner || !repo || !token) {
    console.error('❌ Missing required GitHub parameters for PR analysis');
    setFailed('Missing required GitHub parameters');
    return;
  }

  const octokit = new Octokit({ auth: token });

  // Get PR number from GitHub context
  const gitHubContext = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
  const prNumber = gitHubContext.event?.pull_request?.number;
  const action = gitHubContext.event?.action;

  if (!prNumber) {
    console.error('❌ No PR number found in GitHub context');
    setFailed('No PR number found');
    return;
  }

  console.log(`🔍 Analyzing PR #${prNumber} using Visor config (action: ${action})`);

  try {
    // Use the existing PR analysis infrastructure but with Visor config
    const analyzer = new PRAnalyzer(octokit);
    const reviewer = new PRReviewer(octokit);
    const commentManager = new CommentManager(octokit);

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
        config = await configManager.getDefaultConfig();
      }
    } else {
      config = await configManager.getDefaultConfig();
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
      setOutput('review-score', '100');
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

    // Perform the review
    console.log('🤖 Starting parallel AI review with Visor config...');
    const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, reviewOptions);

    // Update the review summary to show correct checks executed
    if (review.debug) {
      (review.debug as any).checksExecuted = checksToRun;
      (review.debug as any).parallelExecution = true;
    }

    // Post comment using existing comment manager
    const commentId = `visor-config-review-${prNumber}`;
    const reviewComment = reviewer['formatReviewCommentWithVisorFormat'](review, reviewOptions);

    // Add context based on action
    let reviewContext = '';
    if (action === 'opened') {
      reviewContext =
        '## 🚀 Visor Config-Based PR Review!\n\nThis PR has been analyzed using multiple specialized AI checks.\n\n';
    } else {
      reviewContext =
        '## 🔄 Updated Visor Review\n\nThis review has been updated based on PR changes.\n\n';
    }

    const fullComment = reviewContext + reviewComment;

    await commentManager.updateOrCreateComment(owner, repo, prNumber, fullComment, {
      commentId,
      triggeredBy: `visor-config-${action}`,
      allowConcurrentUpdates: true,
    });

    console.log('✅ Posted Visor config-based review comment');

    // Set outputs
    setOutput('auto-review-completed', 'true');
    setOutput('review-score', calculateOverallScore(review.issues).toString());
    setOutput('issues-found', calculateTotalIssues(review.issues).toString());
    setOutput('pr-action', action || 'unknown');
    setOutput('incremental-analysis', action === 'synchronize' ? 'true' : 'false');
    setOutput('visor-config-used', 'true');
    setOutput('checks-executed', checksToRun.join(','));
  } catch (error) {
    console.error('❌ Error in Visor PR analysis:', error);
    setFailed(error instanceof Error ? error.message : 'Visor PR analysis failed');
  }
}

if (require.main === module) {
  run();
}
