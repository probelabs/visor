import { Octokit } from '@octokit/rest';
import { getInput, setOutput, setFailed } from '@actions/core';
import { parseComment, getHelpText } from './commands';
import { PRAnalyzer } from './pr-analyzer';
import { PRReviewer } from './reviewer';
import { ActionCliBridge, GitHubActionInputs, GitHubContext } from './action-cli-bridge';

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
      'visor-config-path': getInput('visor-config-path'),
      'visor-checks': getInput('visor-checks'),
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
    if (cliBridge.shouldUseVisor(inputs)) {
      console.log('🔍 Using Visor CLI mode');
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
    // Create temporary config if needed
    const tempConfigPath = await cliBridge.createTempConfigFromInputs(inputs);
    if (tempConfigPath) {
      inputs['visor-config-path'] = tempConfigPath;
    }

    // Execute CLI
    const result = await cliBridge.executeCliWithContext(inputs);

    if (result.success) {
      console.log('✅ Visor CLI execution completed successfully');
      console.log(result.output);

      // Set outputs based on CLI result
      const outputs = cliBridge.mergeActionAndCliOutputs(inputs, result);
      for (const [key, value] of Object.entries(outputs)) {
        setOutput(key, value);
      }
    } else {
      console.error('❌ Visor CLI execution failed');
      console.error(result.error || result.output);
      setFailed(result.error || 'CLI execution failed');
    }

    // Cleanup temporary files
    await cliBridge.cleanup();
  } catch (error) {
    console.error('❌ Visor mode error:', error);
    setFailed(error instanceof Error ? error.message : 'Visor mode failed');
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
        await handlePullRequestEvent(octokit, owner, repo);
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
        | 'summary'
        | 'detailed'
        | undefined;

      console.log(`Starting PR review for #${prNumber}`);
      const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
      const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo, { focus, format });

      await reviewer.postReviewComment(owner, repo, prNumber, review, { focus, format });

      setOutput('review-score', review.overallScore.toString());
      setOutput('issues-found', review.totalIssues.toString());
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
  repo: string
): Promise<void> {
  const context = JSON.parse(process.env.GITHUB_CONTEXT || '{}');
  const pullRequest = context.event?.pull_request;
  const action = context.event?.action;

  if (!pullRequest || action !== 'opened') {
    console.log('Not a PR opened event');
    return;
  }

  console.log(`Auto-reviewing opened PR #${pullRequest.number}`);

  const prNumber = pullRequest.number;
  const analyzer = new PRAnalyzer(octokit);
  const reviewer = new PRReviewer(octokit);

  const prInfo = await analyzer.fetchPRDiff(owner, repo, prNumber);
  const review = await reviewer.reviewPR(owner, repo, prNumber, prInfo);

  // Add welcome message for auto-review
  const welcomeComment =
    `## 🚀 Welcome to Automated PR Review!\n\n` +
    `This PR has been automatically analyzed. Use \`/help\` to see available commands.\n\n`;

  const fullComment = welcomeComment + reviewer['formatReviewComment'](review, {});

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: fullComment,
  });

  setOutput('auto-review-completed', 'true');
  setOutput('review-score', review.overallScore.toString());
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

if (require.main === module) {
  run();
}
