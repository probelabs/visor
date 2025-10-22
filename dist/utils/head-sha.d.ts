import type { GitHubContext } from '../action-cli-bridge';
/**
 * Resolve the PR head SHA for contexts like issue_comment where payload may not include head.sha.
 * Falls back to a pulls.get API call when needed.
 * Note: typed loosely to avoid importing Octokit in tests.
 */
export declare function resolveHeadShaFromEvent(octokit: any, owner: string, repo: string, context: GitHubContext): Promise<string>;
//# sourceMappingURL=head-sha.d.ts.map