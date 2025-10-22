import type { GitHubContext } from '../types/github';

/**
 * Resolve the PR head SHA for contexts like issue_comment where payload may not include head.sha.
 * Falls back to a pulls.get API call when needed.
 * Note: typed loosely to avoid importing Octokit in tests.
 */
export async function resolveHeadShaFromEvent(
  octokit: any,
  owner: string,
  repo: string,
  context: GitHubContext
): Promise<string> {
  const directSha =
    (context.event as any)?.pull_request?.head?.sha ||
    (context.event as any)?.check_suite?.head_sha ||
    (context.event as any)?.workflow_run?.head_sha ||
    null;
  if (typeof directSha === 'string' && directSha.length > 0) {
    return directSha;
  }

  const prNumber: number | undefined =
    (context.event as any)?.pull_request?.number || (context.event as any)?.issue?.number;
  const hasPRIndicator = Boolean(
    (context.event as any)?.issue?.pull_request || (context.event as any)?.pull_request
  );

  if (hasPRIndicator && typeof prNumber === 'number') {
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      const sha = (data as any)?.head?.sha;
      if (typeof sha === 'string' && sha.length > 0) {
        console.log(`🔗 Resolved PR head SHA via API: ${sha.substring(0, 7)} (PR #${prNumber})`);
        return sha;
      }
    } catch (e) {
      console.warn(
        `⚠️ Failed to resolve head SHA for PR #${prNumber}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  console.warn('⚠️ Could not resolve PR head SHA from event context; falling back to unknown');
  return 'unknown';
}
