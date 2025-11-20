import { EventBus } from '../../src/event-bus/event-bus';
import { GitHubFrontend } from '../../src/frontends/github-frontend';

function makeFakeOctokit() {
  let commentIdSeq = 1000;
  const comments: any[] = [];
  const checksCreated: any[] = [];

  const rest = {
    checks: {
      create: jest.fn(async (req: any) => {
        const id = 5000 + checksCreated.length;
        checksCreated.push({ id, req });
        return { data: { id, html_url: `https://example/check/${id}` } } as any;
      }),
      update: jest.fn(async (_req: any) => ({ data: {} }) as any),
      listForRef: jest.fn(async (_req: any) => ({ data: { check_runs: [] } }) as any),
    },
    issues: {
      listComments: jest.fn(async (_req: any) => ({ data: comments.slice() }) as any),
      getComment: jest.fn(async (req: any) => {
        const found = comments.find(c => c.id === req.comment_id);
        return { data: found } as any;
      }),
      updateComment: jest.fn(async (req: any) => {
        const found = comments.find(c => c.id === req.comment_id);
        if (found) {
          found.body = req.body;
          found.updated_at = new Date().toISOString();
        }
        return { data: found } as any;
      }),
      createComment: jest.fn(async (req: any) => {
        const id = commentIdSeq++;
        const c = {
          id,
          body: req.body,
          user: { login: 'bot' },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        comments.push(c);
        return { data: c } as any;
      }),
    },
  };

  return { rest, __state: { comments, checksCreated } } as any;
}

describe('GitHubFrontend (event-bus v2)', () => {
  test('CheckScheduled creates queued check run but defers comment until content exists', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: undefined,
      run: { runId: 'r-1', repo: { owner: 'o', name: 'r' }, pr: 123, headSha: 'abcdef1' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'overview', scope: ['root'] });

    // Check Run created
    expect(octokit.rest.checks.create).toHaveBeenCalledTimes(1);
    const call = octokit.rest.checks.create.mock.calls[0][0];
    expect(call.name).toBe('Visor: overview');
    expect(call.head_sha).toBe('abcdef1');

    // No comment yet (we defer until content is available)
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
  });

  test('CheckCompleted finalizes check and updates grouped comment', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: undefined,
      run: { runId: 'r-2', repo: { owner: 'o', name: 'r' }, pr: 123, headSha: 'abc9999' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });
    // Still no comment on schedule
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();

    // Complete with 0 issues
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: { issues: [] },
    });

    // Check run completed (update called by service)
    expect(octokit.rest.checks.update).toHaveBeenCalled();

    // Comment created on first completed result
    expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    const body = octokit.__state.comments[0]?.body as string;
    expect(body).toMatch(/visor:section=/);
    expect(body).toContain('security');
  });

  test('GitHub Check conclusion reflects fail_if evaluation (failure when triggered)', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      // Configure a fail_if that fails when any issue exists
      config: {
        checks: {
          security: {
            fail_if: 'Array.isArray(output.issues) && output.issues.length > 0',
            schema: 'code-review',
          },
        },
      },
      run: { runId: 'r-5', repo: { owner: 'o', name: 'r' }, pr: 789, headSha: 'deafbee' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: {
        issues: [{ file: 'a', line: 1, message: 'x', severity: 'error', category: 'logic' }],
      },
    });

    // Last update call should complete with conclusion failure
    const lastUpdate = octokit.rest.checks.update.mock.calls.pop()?.[0];
    expect(lastUpdate).toBeDefined();
    expect(lastUpdate.conclusion).toBe('failure');
  });

  test('GitHub Check conclusion is success when issues exist but fail_if not triggered', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      // No fail_if => presence of issues should not force failure
      config: { checks: { security: { schema: 'code-review' } } },
      run: { runId: 'r-6', repo: { owner: 'o', name: 'r' }, pr: 111, headSha: 'bead123' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: {
        issues: [{ file: 'a', line: 1, message: 'x', severity: 'error', category: 'logic' }],
      },
    });

    const lastUpdate = octokit.rest.checks.update.mock.calls.pop()?.[0];
    expect(lastUpdate).toBeDefined();
    expect(lastUpdate.conclusion).toBe('success');
  });

  test('CheckErrored marks failure; section exists (no extra headers injected)', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: undefined,
      run: { runId: 'r-3', repo: { owner: 'o', name: 'r' }, pr: 234, headSha: 'fff7777' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'quality', scope: ['root'] });
    await bus.emit({
      type: 'CheckErrored',
      checkId: 'quality',
      scope: ['root'],
      error: { message: 'boom' },
    });

    expect(octokit.rest.checks.update).toHaveBeenCalled();
    const body = octokit.__state.comments[0]?.body as string;
    // Section exists for the errored check (content may be empty now)
    expect(body).toMatch(/visor:section=.*quality/);
    // We no longer inject error text into section body; rely on templates only
  });

  test('Partial section update preserves unrelated sections', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: undefined,
      run: { runId: 'r-4', repo: { owner: 'o', name: 'r' }, pr: 345, headSha: 'aaaa111' },
      octokit,
    });

    // Schedule then complete both to create initial comment with both sections
    await bus.emit({ type: 'CheckScheduled', checkId: 'overview', scope: ['root'] });
    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });
    await bus.emit({ type: 'CheckCompleted', checkId: 'overview', scope: ['root'], result: { issues: [], content: 'ov' } });
    await bus.emit({ type: 'CheckCompleted', checkId: 'security', scope: ['root'], result: { issues: [], content: 'sec' } });

    const initialBody = octokit.__state.comments[0]?.body as string;
    expect(initialBody).toContain('overview');
    expect(initialBody).toContain('security');
    const secBlockBefore = extractSection(initialBody, 'security');

    // Update only 'overview'
    await bus.emit({ type: 'CheckCompleted', checkId: 'overview', scope: ['root'], result: { issues: [], content: 'ov2' } });

    const updated = octokit.__state.comments[0]?.body as string;
    expect(updated).toContain('overview');
    expect(updated).toContain('security');
    const secBlockAfter = extractSection(updated, 'security');
    expect(secBlockAfter).toBe(secBlockBefore);
  });

  function extractSection(body: string, id: string): string {
    const startRe = /<!--\s*visor:section=(\{[\s\S]*?\})\s*-->/g;
    const endRe = /<!--\s*visor:section-end\s+id=\"([^\"]+)\"\s*-->/g;
    let cursor = 0;
    while (true) {
      const s = startRe.exec(body);
      if (!s) break;
      const meta = JSON.parse(s[1]);
      const startIdx = startRe.lastIndex;
      endRe.lastIndex = startIdx;
      const e = endRe.exec(body);
      if (!e) break;
      const secId = String(meta.id || e[1]);
      const full = `<!-- visor:section=${JSON.stringify(meta)} -->\n${body
        .substring(startIdx, e.index)
        .trim()}\n<!-- visor:section-end id="${secId}" -->`;
      if (secId === id) return full;
      cursor = endRe.lastIndex;
      startRe.lastIndex = cursor;
    }
    return '';
  }

  test('Creates separate group threads (overview vs review) without mixing sections', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        checks: {
          overview: { group: 'overview', schema: 'overview' },
          security: { group: 'review', schema: 'code-review' },
        },
      },
      run: { runId: 'r-7', repo: { owner: 'o', name: 'r' }, pr: 456, headSha: 'cafebad' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'overview', scope: ['root'] });
    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });
    await bus.emit({ type: 'CheckCompleted', checkId: 'overview', scope: ['root'], result: { issues: [], content: 'ov' } });
    await bus.emit({ type: 'CheckCompleted', checkId: 'security', scope: ['root'], result: { issues: [], content: 'sec' } });

    // Two distinct comments should now exist: one for group=overview, one for group=review
    const bodies = octokit.__state.comments.map((c: any) => String(c.body));
    const headerJsons = bodies.map(parseThreadHeader).filter(Boolean) as any[];
    const groups = headerJsons.map(h => h.group);
    expect(groups.sort()).toEqual(['overview', 'review']);

    // Ensure sections are not mixed
    const overviewBody = bodies.find((b: string) => /\"group\":\"overview\"/.test(b))!;
    const reviewBody = bodies.find((b: string) => /\"group\":\"review\"/.test(b))!;
    expect(overviewBody).toContain('visor:section={');
    expect(overviewBody).toContain('overview');
    expect(overviewBody).not.toContain('security');
    expect(reviewBody).toContain('visor:section={');
    expect(reviewBody).toContain('security');
    expect(reviewBody).not.toContain('overview');
  });

  test('No duplicate sections after multiple updates; content rendered appears', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { security: { group: 'review', schema: 'code-review' } } },
      run: { runId: 'r-8', repo: { owner: 'o', name: 'r' }, pr: 101, headSha: 'abcabcd' },
      octokit,
    });

    await bus.emit({ type: 'CheckScheduled', checkId: 'security', scope: ['root'] });

    // First completion with content
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: { issues: [], content: 'First render content' },
    });

    // Second completion (updated content)
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: { issues: [], content: 'Second render content' },
    });

    const body = octokit.__state.comments.find((c: any) => /\"group\":\"review\"/.test(String(c.body)))
      .body as string;

    // Only one security section block present
    const count = (body.match(/visor:section=.*security/g) || []).length;
    expect(count).toBe(1);
    // Updated content appears
    expect(body).toContain('Second render content');
  });

  function parseThreadHeader(body: string): any | null {
    const m = body.match(/<!--\s*visor:thread=(\{[\s\S]*?\})\s*-->/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
});
