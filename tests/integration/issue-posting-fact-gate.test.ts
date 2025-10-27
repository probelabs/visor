import * as fs from 'fs';
import * as path from 'path';

// Reuse the Octokit REST mock pattern from other integration tests
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

describe.skip('Issue assistant posting is gated by fact validation (issue_opened)', () => {
  beforeEach(() => {
    checksCreate.mockReset();
    checksUpdate.mockReset();
    issuesCreateComment.mockReset();
    issuesListComments.mockClear();
    pullsGet.mockClear();
    pullsListFiles.mockClear();
    // Clean env that run() reads
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

  const makeConfig = (allValid: boolean) => `
version: "1.0"
checks:
  # Minimal issue assistant using mock provider
  issue-assistant:
    type: ai
    ai_provider: mock
    schema: issue-assistant
    on: [issue_opened]
    prompt: |
      Return ONE JSON object for issue-assistant.
      text: Hello, world.

References:

\`\`\`refs
none
\`\`\`
      intent: issue_triage
    on_success:
      run: [init-fact-validation]

  # Initialize validation state
  init-fact-validation:
    type: memory
    operation: set
    namespace: fact-validation
    key: attempt
    value: 0
    on: [issue_opened]

  # Seed deterministic facts instead of invoking AI
  seed-facts:
    type: memory
    operation: set
    namespace: fact-validation
    key: fact_list
    value: [{"id":"f1","category":"Configuration","claim":"X","verifiable":true}]
    depends_on: [issue-assistant]
    on: [issue_opened]

  # forEach extraction proxy
  extract-facts:
    type: memory
    operation: get
    namespace: fact-validation
    key: fact_list
    forEach: true
    depends_on: [seed-facts]
    on: [issue_opened]
    on_finish:
      run: [aggregate-validations]
      goto_js: |
        const ns = 'fact-validation';
        const allValid = memory.get('all_valid', ns) === true;
        const limit = 1; // one retry
        const attempt = Number(memory.get('attempt', ns) || 0);
        if (!allValid && attempt < limit) {
          memory.increment('attempt', 1, ns);
          return 'issue-assistant';
        }
        return null;

  validate-fact:
    type: memory
    operation: exec_js
    namespace: fact-validation
    depends_on: [extract-facts]
    on: [issue_opened]
    memory_js: |
      const NS='fact-validation';
      const f = outputs['extract-facts'];
      const attempt = Number(memory.get('attempt', NS) || 0);
      const is_valid = ${allValid ? 'true' : 'false'}, confidence: 'high', evidence: ${allValid ? "'ok'" : "'bad'"} };

  aggregate-validations:
    type: memory
    operation: exec_js
    namespace: fact-validation
    on: [issue_opened]
    memory_js: |
      const vals = outputs.history['validate-fact'] || [];
      const invalid = (Array.isArray(vals) ? vals : []).filter(v => v && v.is_valid === false);
      const all_valid = invalid.length === 0;
      memory.set('all_valid', all_valid, 'fact-validation');
      return { total: vals.length, all_valid };

  # Emit a simple final note when valid so the Action has content to post once
  final-note:
    type: log
    depends_on: [aggregate-validations]
    if: "memory.get('all_valid','fact-validation') === true"
    message: 'Verified: final'

  # No explicit post step; use Action's generic end-of-run post

output:
  pr_comment:
    format: markdown
    group_by: check
`;

  const writeTmp = (name: string, data: any) => {
    const p = path.join(process.cwd(), name);
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    return p;
  };

  const setupAndRun = async (allValid: boolean) => {
    const cfgPath = writeTmp(
      `.tmp-issue-gate-${allValid ? 'ok' : 'fail'}.yaml`,
      makeConfig(allValid)
    );
    const event = {
      action: 'opened',
      issue: { number: 42, state: 'open' },
      repository: { full_name: 'acme/widgets' },
      sender: { login: 'reporter' },
    } as any;
    const eventPath = writeTmp('.tmp-issues-opened.json', event);

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
    process.env['ENABLE_FACT_VALIDATION'] = 'true';

    // Import run() fresh to pick up env
    jest.resetModules();
    const { run } = await import('../../src/index');
    await run();

    fs.unlinkSync(cfgPath);
    fs.unlinkSync(eventPath);
  };

  it('loops once to correct facts and posts a single final comment', async () => {
    await setupAndRun(false);
    // With attempt limit=1, the first validation fails, we route back to assistant,
    // second pass should be valid and then post once at end.
    expect(issuesCreateComment).toHaveBeenCalledTimes(1);
  });
});
