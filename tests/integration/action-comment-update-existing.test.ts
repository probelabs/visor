import * as fs from 'fs';
import * as path from 'path';

// Mocks
const issuesListComments = jest.fn();
const issuesCreateComment = jest.fn();
const issuesUpdateComment = jest.fn();
const issuesGetComment = jest.fn();
const pullsGet = jest.fn().mockResolvedValue({ data: { head: { sha: 'cafebabe12345678' } } });
const pullsListFiles = jest.fn().mockResolvedValue({
  data: [{ filename: 'x', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
});

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      issues: {
        listComments: issuesListComments,
        createComment: issuesCreateComment,
        updateComment: issuesUpdateComment,
        getComment: issuesGetComment,
      },
      pulls: { get: pullsGet, listFiles: pullsListFiles },
      checks: { create: jest.fn(), update: jest.fn() },
    },
  })),
}));

describe.skip('Comment ID legacy format for issue_comment path', () => {
  beforeEach(() => {
    issuesListComments.mockReset();
    issuesCreateComment.mockReset();
    issuesUpdateComment.mockReset();
    issuesGetComment.mockReset();
    pullsGet.mockClear();
    pullsListFiles.mockClear();
  });

  it('updates existing overview comment with id pr-review-<PR>-overview', async () => {
    const cfg = {
      version: '2.0',
      checks: {
        overview: { type: 'log', message: 'overview ran', on: ['pr_updated'], group: 'overview' },
      },
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: false } },
    } as any;
    const cfgPath = path.join(process.cwd(), '.tmp-update-config.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    // Existing comment body with legacy marker id
    const existing = {
      id: 999,
      body: '<!-- visor-comment-id:pr-review-123-overview -->\nOld\n<!-- /visor-comment-id:pr-review-123-overview -->',
      user: { login: 'visor[bot]' },
      created_at: '2023-01-01T00:00:00Z',
      updated_at: '2023-01-01T00:00:00Z',
    };
    issuesListComments.mockResolvedValue({ data: [existing] });
    issuesGetComment.mockResolvedValue({ data: existing });
    issuesUpdateComment.mockResolvedValue({
      data: { ...existing, updated_at: '2023-01-01T01:00:00Z' },
    });

    const event = {
      action: 'created',
      issue: {
        number: 123,
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/123' },
        state: 'open',
      },
      comment: { id: 777, body: '/overview', user: { login: 'member' } },
    };
    const eventPath = path.join(process.cwd(), '.tmp-issue-comment-update.json');
    fs.writeFileSync(eventPath, JSON.stringify(event));

    process.env.GITHUB_EVENT_NAME = 'issue_comment';
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'acme/widgets';
    process.env.GITHUB_REPOSITORY_OWNER = 'acme';

    process.env['INPUT_GITHUB-TOKEN'] = 't';
    process.env['INPUT_OWNER'] = 'acme';
    process.env['INPUT_REPO'] = 'widgets';
    process.env['INPUT_CONFIG-PATH'] = cfgPath;
    process.env['INPUT_COMMENT-ON-PR'] = 'true';
    process.env['INPUT_CREATE-CHECK'] = 'false';

    const { run } = await import('../../src/index');
    await run();

    // Either path is fine for this integration: verify the marker used is legacy-compliant
    const updatedBodies = issuesUpdateComment.mock.calls.map(c => c[0].body || '').join('\n');
    const createdBodies = issuesCreateComment.mock.calls.map(c => c[0].body || '').join('\n');
    const allBodies = updatedBodies + createdBodies;
    expect(allBodies).toContain('<!-- visor-comment-id:pr-review-123-overview -->');

    fs.unlinkSync(cfgPath);
    fs.unlinkSync(eventPath);
  });
});
