/**
 * E2E Test: comment-assistant pipeline
 *
 * Reproduces the production bug where:
 *   1. The engine runs a check with schema: issue-assistant
 *   2. The AI produces output { text: "...", intent: "comment_reply" }
 *   3. renderTemplateContent renders the Liquid template
 *   4. The result flows through EventBus → GitHubFrontend → GitHub comment
 *   5. BUG: The comment body was EMPTY (only section markers, no content)
 *
 * This test runs the real StateMachineExecutionEngine (with a command check
 * that outputs issue-assistant JSON), wires up EventBus + GitHubFrontend
 * with a mock Octokit, and asserts that the posted comment body is non-empty.
 */

import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { EventBus } from '../../src/event-bus/event-bus';
import { GitHubFrontend } from '../../src/frontends/github-frontend';
import type { PRInfo } from '../../src/pr-analyzer';
import type { VisorConfig } from '../../src/types/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_AI_TEXT =
  'Here is my analysis of the code. The path.Join call does not sanitise user-supplied segments.';

/** Minimal PRInfo that the engine accepts */
const prInfo: PRInfo = {
  number: 7880,
  title: 'Fix path traversal in API handler',
  author: 'testuser',
  base: 'main',
  head: 'fix/path-traversal',
  files: [],
  totalAdditions: 10,
  totalDeletions: 2,
  eventType: 'issue_comment',
} as any;

/** Build a fake Octokit that tracks comments and check runs */
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

// ---------------------------------------------------------------------------
// Test 1: Engine → result.content is non-empty for issue-assistant schema
// ---------------------------------------------------------------------------
describe('comment-assistant E2E pipeline', () => {
  it('engine returns non-empty content for a check with schema: issue-assistant', async () => {
    // Use a command check that outputs issue-assistant JSON
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'comment-assistant': {
          type: 'command',
          group: 'dynamic',
          schema: 'issue-assistant',
          exec: `echo '${JSON.stringify({ text: MOCK_AI_TEXT, intent: 'comment_reply' })}'`,
          output_format: 'json',
        },
      },
      output: {
        pr_comment: { enabled: false, format: 'markdown', group_by: 'check', collapse: false },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const result = await engine.executeGroupedChecks(
      prInfo,
      ['comment-assistant'],
      30000,
      config,
      'json',
      false
    );

    // Flatten results
    const allResults = Object.values(result.results).flat();
    const commentAssistantResult = allResults.find((r: any) => r.checkName === 'comment-assistant');

    expect(commentAssistantResult).toBeDefined();

    // The output must contain our text
    expect(commentAssistantResult!.output).toBeDefined();
    const outputObj =
      typeof commentAssistantResult!.output === 'string'
        ? JSON.parse(commentAssistantResult!.output as string)
        : commentAssistantResult!.output;
    expect(outputObj.text).toContain('Here is my analysis');

    // CRITICAL: content (from renderTemplateContent) must be non-empty
    // This is what was EMPTY in production, causing the empty GitHub comment
    expect(commentAssistantResult!.content).toBeDefined();
    expect(typeof commentAssistantResult!.content).toBe('string');
    expect(commentAssistantResult!.content.trim().length).toBeGreaterThan(0);
    expect(commentAssistantResult!.content).toContain('Here is my analysis');
  });

  // ---------------------------------------------------------------------------
  // Test 2: Full E2E — Engine result → EventBus → GitHubFrontend → comment
  //
  // Runs the real engine to get the CheckResult (with rendered content),
  // then feeds the exact result through EventBus → GitHubFrontend → mock Octokit.
  // This proves the full data flow from engine output to posted comment.
  // ---------------------------------------------------------------------------
  it('full pipeline: engine result → event bus → GitHubFrontend → non-empty comment', async () => {
    // Step 1: Run the real engine to get the CheckResult
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        'comment-assistant': {
          type: 'command',
          group: 'dynamic',
          schema: 'issue-assistant',
          exec: `echo '${JSON.stringify({ text: MOCK_AI_TEXT, intent: 'comment_reply' })}'`,
          output_format: 'json',
        },
      },
      output: {
        pr_comment: { enabled: false, format: 'markdown', group_by: 'check', collapse: false },
      },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const result = await engine.executeGroupedChecks(
      prInfo,
      ['comment-assistant'],
      30000,
      config,
      'json',
      false
    );

    const allResults = Object.values(result.results).flat();
    const cr = allResults.find((r: any) => r.checkName === 'comment-assistant');
    expect(cr).toBeDefined();

    // Step 2: Wire up EventBus + GitHubFrontend with mock Octokit
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();

    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        checks: {
          'comment-assistant': {
            type: 'command',
            group: 'dynamic',
            schema: 'issue-assistant',
          },
        },
      },
      run: {
        runId: 'e2e-comment-test',
        repo: { owner: 'TykTechnologies', name: 'tyk' },
        pr: 7880,
        headSha: 'deadbeef1234567',
        event: 'issue_comment',
      },
      octokit,
    });

    // Step 3: Emit CheckCompleted with the REAL engine result
    // This is exactly what the runner.ts emitEvent() produces
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'comment-assistant',
      scope: [],
      result: {
        issues: cr!.issues || [],
        output: cr!.output,
        content: cr!.content, // This is the rendered template content from the engine
      },
    });

    // Give the frontend time to process async events
    await new Promise(r => setTimeout(r, 500));

    await fe.stop();

    // Step 4: Verify the GitHub comment was posted with actual content
    const { comments } = octokit.__state;
    expect(comments.length).toBeGreaterThanOrEqual(1);

    const visorComment = comments.find((c: any) => c.body?.includes('comment-assistant'));
    expect(visorComment).toBeDefined();

    // CRITICAL: The comment body must contain the actual analysis text
    // In production, this was EMPTY (only section markers, no content)
    expect(visorComment.body).toContain('Here is my analysis');
    expect(visorComment.body).toContain('path.Join');
  });

  // ---------------------------------------------------------------------------
  // Test 3: When template rendering fails, frontend fallback extracts output.text
  // ---------------------------------------------------------------------------
  it('frontend falls back to output.text when content is undefined', async () => {
    const bus = new EventBus();
    const octokit = makeFakeOctokit();
    const fe = new GitHubFrontend();

    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        checks: {
          'comment-assistant': {
            type: 'ai',
            group: 'dynamic',
            schema: 'issue-assistant',
          },
        },
      },
      run: {
        runId: 'e2e-fallback-test',
        repo: { owner: 'TykTechnologies', name: 'tyk' },
        pr: 7880,
        headSha: 'deadbeef1234567',
        event: 'issue_comment',
      },
      octokit,
    });

    // Simulate exactly what happens in production when template rendering fails:
    // The engine emits CheckCompleted with content=undefined but output={text: "..."}
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'comment-assistant',
      scope: [],
      result: {
        issues: [],
        output: { text: MOCK_AI_TEXT, intent: 'comment_reply' },
        content: undefined, // template rendering returned undefined
      },
    });

    // Give the frontend time to process
    await new Promise(r => setTimeout(r, 500));

    await fe.stop();

    const { comments } = octokit.__state;
    expect(comments.length).toBeGreaterThanOrEqual(1);

    const visorComment = comments.find((c: any) => c.body?.includes('comment-assistant'));
    expect(visorComment).toBeDefined();

    // With the fix, the frontend should fall back to output.text
    // Without the fix, this would be EMPTY
    expect(visorComment.body).toContain('Here is my analysis');
  });
});
