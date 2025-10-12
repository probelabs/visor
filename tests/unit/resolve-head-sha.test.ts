import { resolveHeadShaFromEvent } from '../../src/utils/head-sha';
import type { GitHubContext } from '../../src/action-cli-bridge';

describe('resolveHeadShaFromEvent', () => {
  const owner = 'acme';
  const repo = 'widgets';

  test('returns direct head sha when present on pull_request payload', async () => {
    const octokit: any = { rest: { pulls: { get: jest.fn() } } };
    const ctx: GitHubContext = {
      event_name: 'pull_request',
      event: { pull_request: { head: { sha: 'abc1234deadbeef' }, number: 42 } },
    } as any;

    const sha = await resolveHeadShaFromEvent(octokit, owner, repo, ctx);
    expect(sha).toBe('abc1234deadbeef');
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  test('fetches PR to obtain head sha for issue_comment on PR', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'f00ba71234567890' } } }),
        },
      },
    };

    const ctx: GitHubContext = {
      event_name: 'issue_comment',
      event: { issue: { number: 101, pull_request: { url: 'https://api.github.com/...' } } },
    } as any;

    const sha = await resolveHeadShaFromEvent(octokit, owner, repo, ctx);
    expect(sha).toBe('f00ba71234567890');
    expect(octokit.rest.pulls.get).toHaveBeenCalledWith({ owner, repo, pull_number: 101 });
  });

  test('returns unknown when not a PR context', async () => {
    const octokit: any = { rest: { pulls: { get: jest.fn() } } };
    const ctx: GitHubContext = {
      event_name: 'issue_comment',
      event: { issue: { number: 7 } },
    } as any;

    const sha = await resolveHeadShaFromEvent(octokit, owner, repo, ctx);
    expect(sha).toBe('unknown');
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });

  test('returns unknown when API fetch fails', async () => {
    const octokit: any = {
      rest: {
        pulls: {
          get: jest.fn().mockRejectedValue(new Error('Not Found')),
        },
      },
    };

    const ctx: GitHubContext = {
      event_name: 'issue_comment',
      event: { issue: { number: 55, pull_request: { url: 'x' } } },
    } as any;

    const sha = await resolveHeadShaFromEvent(octokit, owner, repo, ctx);
    expect(sha).toBe('unknown');
    expect(octokit.rest.pulls.get).toHaveBeenCalled();
  });
});
