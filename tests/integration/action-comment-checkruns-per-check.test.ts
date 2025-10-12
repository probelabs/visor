import * as fs from 'fs';
import * as path from 'path';

// Mock @octokit/rest to capture check run creation calls
const checksCreate = jest.fn();
const checksUpdate = jest.fn();
const issuesCreateComment = jest.fn();
const issuesListComments = jest.fn().mockResolvedValue({ data: [] });
const pullsGet = jest.fn().mockResolvedValue({ data: { head: { sha: 'deadbeefcafebabe' } } });
const pullsListFiles = jest.fn().mockResolvedValue({
  data: [{ filename: 'x', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
});

jest.mock('@octokit/rest', () => {
  return {
    Octokit: jest.fn().mockImplementation(() => ({
      rest: {
        checks: { create: checksCreate, update: checksUpdate },
        issues: { createComment: issuesCreateComment, listComments: issuesListComments },
        pulls: { get: pullsGet, listFiles: pullsListFiles },
      },
    })),
  };
});

describe('GitHub Checks on issue_comment rerun (per check)', () => {
  beforeEach(() => {
    checksCreate.mockReset();
    checksUpdate.mockReset();
    issuesCreateComment.mockReset();
    issuesListComments.mockClear();
    pullsGet.mockClear();
    pullsListFiles.mockClear();
  });

  it('creates one check run per executed check (initiator + routed child)', async () => {
    // Write a minimal config to a temp file
    const cfg = {
      version: '2.0',
      routing: { max_loops: 3 },
      checks: {
        'comment-assistant': {
          type: 'log',
          message: 'rerun requested',
          on: ['issue_comment'],
          on_success: { goto_js: "return 'overview'", goto_event: 'pr_updated' },
        },
        overview: { type: 'log', message: 'overview ran', on: ['pr_updated'] },
      },
      output: {
        pr_comment: { format: 'markdown', group_by: 'check' },
        github_checks: { enabled: true },
      },
    } as any;

    const cfgPath = path.join(process.cwd(), '.tmp-comment-checks.yaml');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    // Prepare issue_comment event on a PR with command /comment-assistant
    const event = {
      action: 'created',
      issue: {
        number: 123,
        pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/123' },
        state: 'open',
      },
      comment: { id: 555, body: '/comment-assistant', user: { login: 'member' } },
    };
    const eventPath = path.join(process.cwd(), '.tmp-issue-comment.json');
    fs.writeFileSync(eventPath, JSON.stringify(event));

    // Minimal env for run()
    process.env.GITHUB_EVENT_NAME = 'issue_comment';
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'acme/widgets';
    process.env.GITHUB_REPOSITORY_OWNER = 'acme';

    // Action inputs
    process.env['INPUT_GITHUB-TOKEN'] = 'test-token';
    process.env['INPUT_OWNER'] = 'acme';
    process.env['INPUT_REPO'] = 'widgets';
    process.env['INPUT_CONFIG-PATH'] = cfgPath; // use our temp config
    process.env['INPUT_CREATE-CHECK'] = 'true';
    process.env['INPUT_COMMENT-ON-PR'] = 'false'; // skip PR comments in test
    process.env['INPUT_DEBUG'] = 'true';

    // Import run() fresh to pick up env
    const { run } = await import('../../src/index');
    await run();

    // Expect a check run for each executed check: comment-assistant and overview
    const createdNames = checksCreate.mock.calls.map(c => c[0].name).sort();
    expect(createdNames).toEqual(['Visor: comment-assistant', 'Visor: overview'].sort());

    // Clean up temp files
    fs.unlinkSync(cfgPath);
    fs.unlinkSync(eventPath);
  });
});
