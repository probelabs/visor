import { EventBus } from '../../src/event-bus/event-bus';
import { GitHubFrontend } from '../../src/frontends/github-frontend';

function makeFakeOctokitWithSeed(seedComments: any[] = []) {
  let commentIdSeq = 4000;
  const comments: any[] = seedComments.slice();
  const checksCreated: any[] = [];

  const rest = {
    checks: {
      create: jest.fn(async (req: any) => {
        const id = 8000 + checksCreated.length;
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

describe('GitHubFrontend security: parseSections sanitization', () => {
  test('Ignores dangerous keys in header/section meta and prevents prototype pollution', async () => {
    // Craft a malicious existing comment body that looks like a Visor thread
    const commentId = 'visor-thread-review-o/r#999';
    const malicious = `<!-- visor-comment-id:${commentId} -->
<!-- visor:thread={"key":"o/r#999@deadbeef","__proto__":{"polluted":true},"generatedAt":"2025-01-01T00:00:00.000Z","extra":123} -->
<!-- visor:section={"id":"security","__proto__":{"bad":1},"revision":7} -->
old content
<!-- visor:section-end id="security" -->
<!-- /visor-comment-id:${commentId} -->`;

    const bus = new EventBus();
    const octokit = makeFakeOctokitWithSeed([
      { id: 9999, body: malicious, updated_at: new Date().toISOString() },
    ]);
    const fe = new GitHubFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { security: { group: 'review', schema: 'code-review' } } },
      run: {
        runId: 'r-sec',
        repo: { owner: 'o', name: 'r' },
        pr: 999,
        headSha: 'feedbee',
        event: 'pr_updated',
      },
      octokit,
    });

    // Complete check with new safe content
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: ['root'],
      result: { issues: [], content: 'SAFE' },
    });

    const body = octokit.__state.comments.find((c: any) => String(c.body).includes(commentId))
      ?.body as string;
    expect(body).toBeTruthy();

    // Header should not contain __proto__ and only allowed keys
    const m = body.match(/<!--\s*visor:thread=(\{[\s\S]*?\})\s*-->/);
    expect(m).toBeTruthy();
    const headerJson = m![1];
    expect(headerJson).not.toContain('__proto__');

    // Section meta should not include dangerous keys
    expect(body).toMatch(/visor:section=\{/);
    const sectionMetaStr = (body.match(/visor:section=(\{[\s\S]*?\})/) || [])[1];
    expect(sectionMetaStr).toContain('"id"');
    expect(sectionMetaStr).not.toContain('__proto__');

    // Ensure prototype is not polluted
    expect(({} as any).polluted).toBeUndefined();
  });
});
