import * as fs from 'fs';
import * as path from 'path';

// Minimal Octokit REST mock to capture posted comment body
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
        issues: { createComment: issuesCreateComment, listComments: issuesListComments },
        pulls: { get: pullsGet, listFiles: pullsListFiles },
        checks: { create: jest.fn(), update: jest.fn() },
      },
    })),
  };
});

describe('Issue assistant double-content detection (issues opened)', () => {
  beforeEach(() => {
    issuesCreateComment.mockReset();
    issuesListComments.mockClear();
    pullsGet.mockClear();
    pullsListFiles.mockClear();

    // Clean env used by action run()
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_EVENT_PATH;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY_OWNER;
    delete process.env['INPUT_GITHUB-TOKEN'];
    delete process.env['INPUT_OWNER'];
    delete process.env['INPUT_REPO'];
    delete process.env['INPUT_CONFIG-PATH'];
    delete process.env['INPUT_CREATE-CHECK'];
    delete process.env['INPUT_COMMENT-ON-PR'];
    delete process.env['INPUT_DEBUG'];
  });

  const writeTmp = (name: string, data: any) => {
    const p = path.join(process.cwd(), name);
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    return p;
  };

  // This config intentionally produces two assistant-style outputs in the same run.
  // With current behavior, both get concatenated into the single issue comment.
  // We assert that only one assistant response appears (i.e., deduped/collapsed),
  // so this test should fail until the posting logic is fixed.
  const makeConfig = () => `
version: "1.0"
checks:
  assistant-initial:
    type: ai
    ai_provider: mock
    schema: issue-assistant
    group: dynamic
    on: [issue_opened]
    prompt: |
      Return ONE JSON object for issue-assistant.
      text: ### Assistant Reply
      intent: issue_triage

  assistant-refined:
    type: ai
    ai_provider: mock
    schema: issue-assistant
    group: dynamic
    depends_on: [assistant-initial]
    on: [issue_opened]
    prompt: |
      Return ONE JSON object for issue-assistant.
      text: ### Assistant Reply
      intent: issue_triage

output:
  pr_comment:
    format: markdown
    group_by: check
`;

  it('posts only the refined answer (no duplicate old+new content)', async () => {
    const cfgPath = writeTmp('.tmp-double-content.yaml', makeConfig());
    const event = {
      action: 'opened',
      issue: { number: 77, state: 'open' },
      repository: { full_name: 'acme/widgets' },
      sender: { login: 'reporter' },
    } as any;
    const eventPath = writeTmp('.tmp-issues-opened-double.json', event);

    process.env.GITHUB_EVENT_NAME = 'issues';
    process.env.GITHUB_EVENT_PATH = eventPath;
    process.env.GITHUB_REPOSITORY = 'acme/widgets';
    process.env.GITHUB_REPOSITORY_OWNER = 'acme';
    process.env['INPUT_GITHUB-TOKEN'] = 'test-token';
    process.env['INPUT_OWNER'] = 'acme';
    process.env['INPUT_REPO'] = 'widgets';
    process.env['INPUT_CONFIG-PATH'] = cfgPath;
    process.env['INPUT_CREATE-CHECK'] = 'false';
    process.env['INPUT_COMMENT-ON-PR'] = 'false';
    process.env['INPUT_DEBUG'] = 'true';

    jest.resetModules();
    const { run } = await import('../../src/index');
    await run();

    // Exactly one comment is posted
    expect(issuesCreateComment).toHaveBeenCalledTimes(1);
    const call = issuesCreateComment.mock.calls[0][0];
    const body: string = call.body;
    // Debug: persist body for local inspection
    fs.mkdirSync('tmp', { recursive: true });
    fs.writeFileSync('tmp/issue-double-content-body.md', body, 'utf8');

    // Desired behavior: Only a single assistant response should appear.
    // Current bug: both initial and refined outputs are concatenated. In the
    // mock path the provider sometimes returns a minimal JSON like {"issues":[]}.
    // Assert that only one such block exists.
    const jsonBlockCount = (body.match(/\{\s*\"issues\"\s*:\s*\[\]\s*\}/g) || []).length;
    expect(jsonBlockCount).toBe(1);

    fs.unlinkSync(cfgPath);
    fs.unlinkSync(eventPath);
  });
});
