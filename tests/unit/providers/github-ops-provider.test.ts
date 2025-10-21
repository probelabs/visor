/* eslint-disable @typescript-eslint/no-explicit-any */
import { GitHubOpsProvider } from '../../../src/providers/github-ops-provider';
import type { PRInfo } from '../../../src/pr-analyzer';

// Mock Octokit REST client
jest.mock('@octokit/rest', () => {
  const addLabels = jest.fn().mockResolvedValue({});
  const removeLabel = jest.fn().mockResolvedValue({});
  const createComment = jest.fn().mockResolvedValue({});

  const instance = {
    rest: {
      issues: { addLabels, removeLabel, createComment },
    },
  };

  const Octokit = jest.fn().mockImplementation(() => instance);

  // Expose fns for assertions
  (Octokit as any).__mock = { addLabels, removeLabel, createComment };

  return { Octokit };
});

describe('GitHubOpsProvider - empty value handling', () => {
  const makePr = (num = 1): PRInfo => ({
    number: num,
    title: 't',
    body: '',
    author: 'u',
    base: 'main',
    head: 'branch',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  });

  let mockOctokit: any;

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.GITHUB_REPOSITORY = 'owner/repo';

    // Create mock octokit instance
    const { Octokit } = await import('@octokit/rest');
    mockOctokit = new Octokit();
  });

  it('filters empty strings and de-duplicates for labels.add', async () => {
    const provider = new GitHubOpsProvider();
    const pr = makePr(42);
    const cfg: any = {
      type: 'github',
      op: 'labels.add',
      values: ['', 'foo', ' ', 'bar', 'foo', '', '   '],
      eventContext: { octokit: mockOctokit },
    };

    await provider.execute(pr, cfg);

    const { Octokit } = await import('@octokit/rest');
    const mockApi = (Octokit as any).__mock;
    expect(mockApi.addLabels).toHaveBeenCalledTimes(1);
    expect(mockApi.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 42,
      labels: ['foo', 'bar'],
    });
  });

  it('does not call API when labels are empty after filtering', async () => {
    const provider = new GitHubOpsProvider();
    const pr = makePr(7);
    const cfg: any = {
      type: 'github',
      op: 'labels.add',
      values: [' ', '', '   '],
      eventContext: { octokit: mockOctokit },
    };

    await provider.execute(pr, cfg);

    const { Octokit } = await import('@octokit/rest');
    const mockApi = (Octokit as any).__mock;
    expect(mockApi.addLabels).not.toHaveBeenCalled();
  });

  it('trims and ignores empties when creating comments', async () => {
    const provider = new GitHubOpsProvider();
    const pr = makePr(9);
    const cfg: any = {
      type: 'github',
      op: 'comment.create',
      values: ['', '  hello  ', '', ''],
      eventContext: { octokit: mockOctokit },
    };

    await provider.execute(pr, cfg);

    const { Octokit } = await import('@octokit/rest');
    const mockApi = (Octokit as any).__mock;
    expect(mockApi.createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 9,
      body: 'hello',
    });
  });

  it('preserves spaces in label names like "good first issue"', async () => {
    const provider = new GitHubOpsProvider();
    const pr = makePr(10);
    const cfg: any = {
      type: 'github',
      op: 'labels.add',
      values: ['good first issue', 'enhancement', 'ui/ux'],
      eventContext: { octokit: mockOctokit },
    };

    await provider.execute(pr, cfg);

    const { Octokit } = await import('@octokit/rest');
    const mockApi = (Octokit as any).__mock;
    expect(mockApi.addLabels).toHaveBeenCalledTimes(1);
    expect(mockApi.addLabels).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 10,
      labels: ['good first issue', 'enhancement', 'ui/ux'],
    });
  });
});
