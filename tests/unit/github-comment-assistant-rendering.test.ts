/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Test: comment-assistant AI check output renders into GitHub comment body
 *
 * Bug: When `comment-assistant` (schema: issue-assistant) returns valid output
 * like { text: "Here's my analysis...", intent: "comment_reply" }, the GitHub
 * comment posted is EMPTY — just section markers with no content.
 *
 * Evidence: production log from TykTechnologies/tyk PR #7880 shows
 * `<!-- visor:section={"id":"comment-assistant"} -->` with no body.
 *
 * This test verifies the FULL pipeline:
 *   AI provider returns structured output
 *   → renderTemplateContent renders the issue-assistant Liquid template
 *   → CheckCompleted event carries rendered content
 *   → GitHubFrontend posts comment with the text
 */

import { GitHubFrontend } from '../../src/frontends/github-frontend';
import { renderTemplateContent } from '../../src/state-machine/dispatch/template-renderer';
import { extractTextFromJson } from '../../src/utils/json-text-extractor';
import type { FrontendContext } from '../../src/frontends/host';
import type { ReviewSummary } from '../../src/reviewer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal FrontendContext that looks like a real GitHub issue_comment run */
function buildFrontendContext(overrides?: Partial<FrontendContext>): FrontendContext {
  return {
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    eventBus: {
      on: jest.fn().mockReturnValue({ unsubscribe: jest.fn() }),
      emit: jest.fn(),
    },
    run: {
      runId: 'run-issue-comment-12345',
      workflowId: 'wf-1',
      repo: { owner: 'TykTechnologies', name: 'tyk' },
      pr: 7880,
      headSha: 'deadbeef1234567',
      event: 'issue_comment',
      actor: 'someuser',
    },
    config: {
      output: { pr_comment: { enabled: true } },
      checks: {
        'comment-assistant': {
          type: 'ai',
          group: 'dynamic',
          on: ['issue_comment'],
          command: 'visor',
          schema: 'issue-assistant',
          prompt: 'You are the comment assistant...',
        },
      },
      steps: {
        'comment-assistant': {
          type: 'ai',
          group: 'dynamic',
          on: ['issue_comment'],
          command: 'visor',
          schema: 'issue-assistant',
          prompt: 'You are the comment assistant...',
        },
      },
    },
    ...(overrides as any),
  } as any;
}

// The AI output exactly as the AI provider would return for issue-assistant schema
const MOCK_AI_OUTPUT = {
  text: 'Here is my analysis of the security concern.\n\n## Path Traversal\n\nThe `path.Join` call does not sanitise user-supplied segments, so an attacker could pass `../../etc/passwd` to escape the intended directory.\n\nReferences: none',
  intent: 'comment_reply',
};

// What the AI provider returns as ReviewSummary
const MOCK_REVIEW_RESULT: ReviewSummary & { output?: unknown; content?: string } = {
  issues: [],
  output: MOCK_AI_OUTPUT,
};

// ---------------------------------------------------------------------------
// Test 1: renderTemplateContent produces non-empty content for issue-assistant
// ---------------------------------------------------------------------------
describe('comment-assistant rendering pipeline', () => {
  describe('renderTemplateContent (issue-assistant schema)', () => {
    it('should render output.text from the issue-assistant Liquid template', async () => {
      const checkConfig = {
        schema: 'issue-assistant',
        type: 'ai',
        group: 'dynamic',
      };

      const reviewSummary: any = {
        issues: [],
        output: { ...MOCK_AI_OUTPUT },
      };

      const rendered = await renderTemplateContent('comment-assistant', checkConfig, reviewSummary);

      // The template is: {{ output.text | default: output.response | ... | unescape_newlines }}
      // With output.text set, it MUST render the text content
      expect(rendered).toBeDefined();
      expect(typeof rendered).toBe('string');
      expect(rendered!.length).toBeGreaterThan(0);
      expect(rendered).toContain('Here is my analysis');
      expect(rendered).toContain('Path Traversal');
    });

    it('should render even when output is a JSON string (double-serialized)', async () => {
      const checkConfig = {
        schema: 'issue-assistant',
        type: 'ai',
        group: 'dynamic',
      };

      // Simulate the case where output is a JSON string rather than an object
      const reviewSummary: any = {
        issues: [],
        output: JSON.stringify(MOCK_AI_OUTPUT),
      };

      const rendered = await renderTemplateContent('comment-assistant', checkConfig, reviewSummary);

      expect(rendered).toBeDefined();
      expect(rendered!.length).toBeGreaterThan(0);
      expect(rendered).toContain('Here is my analysis');
    });
  });

  // ---------------------------------------------------------------------------
  // Test 2: extractTextFromJson preserves rendered content
  // ---------------------------------------------------------------------------
  describe('extractTextFromJson', () => {
    it('should pass through plain rendered markdown text', () => {
      const rendered = 'Here is my analysis of the security concern.\n\n## Path Traversal';
      const result = extractTextFromJson(rendered);
      expect(result).toBe(rendered);
    });

    it('should extract text from a JSON object with text field', () => {
      const result = extractTextFromJson(MOCK_AI_OUTPUT);
      expect(result).toBeDefined();
      expect(result).toContain('Here is my analysis');
    });

    it('should extract text from a JSON string with text field', () => {
      const result = extractTextFromJson(JSON.stringify(MOCK_AI_OUTPUT));
      expect(result).toBeDefined();
      expect(result).toContain('Here is my analysis');
    });

    it('should return undefined for undefined input', () => {
      expect(extractTextFromJson(undefined)).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Test 3: Full GitHubFrontend flow — CheckCompleted → comment posted
  // ---------------------------------------------------------------------------
  describe('GitHubFrontend: CheckCompleted → GitHub comment', () => {
    let frontend: GitHubFrontend;
    let capturedHandlers: Record<string, Function>;
    let mockCommentManager: any;
    let mockOctokit: any;
    let ctx: FrontendContext;

    beforeEach(() => {
      jest.useFakeTimers();
      capturedHandlers = {};

      mockCommentManager = {
        findVisorComment: jest.fn().mockResolvedValue(null),
        updateOrCreateComment: jest.fn().mockResolvedValue({
          id: 42,
          body: 'created',
          user: { login: 'visor[bot]' },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      };

      // Mock require so GitHubFrontend finds CommentManager and GitHubCheckService
      jest.mock('../../src/github-comments', () => ({
        CommentManager: jest.fn().mockImplementation(() => mockCommentManager),
      }));
      jest.mock('../../src/github-check-service', () => ({
        GitHubCheckService: jest.fn().mockImplementation(() => ({
          createCheckRun: jest.fn().mockResolvedValue({ id: 1 }),
          completeCheckRun: jest.fn().mockResolvedValue({}),
        })),
      }));
      jest.mock('../../src/failure-condition-evaluator', () => ({
        FailureConditionEvaluator: jest.fn().mockImplementation(() => ({
          evaluateSimpleCondition: jest.fn().mockResolvedValue(false),
        })),
      }));

      mockOctokit = { rest: { issues: {} } };

      ctx = buildFrontendContext();

      // Capture event handlers registered by start()
      (ctx.eventBus.on as jest.Mock).mockImplementation((event: string, handler: Function) => {
        capturedHandlers[event] = handler;
        return { unsubscribe: jest.fn() };
      });

      frontend = new GitHubFrontend();
      frontend.minUpdateDelayMs = 0; // no delay in tests

      // Inject octokit into context
      (ctx as any).octokit = mockOctokit;

      frontend.start(ctx);
    });

    afterEach(async () => {
      await frontend.stop();
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('should post comment with rendered text content (not empty)', async () => {
      // First render the template (as the engine would)
      const checkConfig = {
        schema: 'issue-assistant',
        type: 'ai',
        group: 'dynamic',
      };
      const renderedContent = await renderTemplateContent(
        'comment-assistant',
        checkConfig,
        MOCK_REVIEW_RESULT as any
      );

      // Sanity: rendering must have produced content
      expect(renderedContent).toBeDefined();
      expect(renderedContent!.length).toBeGreaterThan(0);

      // Simulate the CheckCompleted event as emitted by the execution engine
      // (see execution-invoker.ts lines 973-982)
      const checkCompletedPayload = {
        type: 'CheckCompleted',
        checkId: 'comment-assistant',
        scope: [],
        result: {
          issues: [],
          output: MOCK_AI_OUTPUT,
          content: renderedContent || (MOCK_REVIEW_RESULT as any).content,
        },
      };

      // Invoke the handler
      const handler = capturedHandlers['CheckCompleted'];
      expect(handler).toBeDefined();

      const handlerPromise = handler({ payload: checkCompletedPayload });
      await jest.runAllTimersAsync();
      await handlerPromise;

      // The comment manager must have been called
      expect(mockCommentManager.updateOrCreateComment).toHaveBeenCalledTimes(1);

      // Get the body that was posted
      const postedBody = mockCommentManager.updateOrCreateComment.mock.calls[0][3]; // 4th argument is body

      // The posted body MUST contain the actual analysis text
      expect(postedBody).toBeDefined();
      expect(typeof postedBody).toBe('string');
      expect(postedBody.length).toBeGreaterThan(0);

      // The section markers should exist
      expect(postedBody).toContain('visor:section=');
      expect(postedBody).toContain('comment-assistant');

      // CRITICAL: The actual text content must be present between the markers
      expect(postedBody).toContain('Here is my analysis');
      expect(postedBody).toContain('Path Traversal');
    });

    it('should post comment with text when result.content is the raw AI output object (bug path)', async () => {
      // This simulates the bug scenario: when renderedContent is undefined
      // (e.g., template not found), and result.content is also undefined,
      // the frontend receives ev.result.content = undefined
      // and extractTextFromJson(undefined) = undefined
      // → section body is empty

      // Simulate CheckCompleted where template rendering FAILED
      // (renderedContent = undefined), so content falls back to (result as any).content
      // which is also undefined since ReviewSummary doesn't have a content field
      const checkCompletedPayload = {
        type: 'CheckCompleted',
        checkId: 'comment-assistant',
        scope: [],
        result: {
          issues: [],
          output: MOCK_AI_OUTPUT,
          content: undefined, // This is `renderedContent || (result as any).content` when both are undefined
        },
      };

      const handler = capturedHandlers['CheckCompleted'];
      const handlerPromise = handler({ payload: checkCompletedPayload });
      await jest.runAllTimersAsync();
      await handlerPromise;

      expect(mockCommentManager.updateOrCreateComment).toHaveBeenCalledTimes(1);

      const postedBody = mockCommentManager.updateOrCreateComment.mock.calls[0][3];

      // Even when content is undefined, the frontend calls extractTextFromJson on it
      // which returns undefined, so the section body is EMPTY.
      // The frontend should fall back to extracting text from the output object.
      // This assertion will FAIL on the current codebase, proving the bug:
      // The frontend does not fall back to output.text when content is undefined.
      expect(postedBody).toContain('Here is my analysis');
    });

    it('should extract text from output when content field is missing', async () => {
      // Another angle: the engine emits CheckCompleted where content is undefined
      // but output has the text. The frontend should use output.text as fallback.
      const checkCompletedPayload = {
        type: 'CheckCompleted',
        checkId: 'comment-assistant',
        scope: [],
        result: {
          issues: [],
          output: MOCK_AI_OUTPUT,
          // No content field at all
        },
      };

      const handler = capturedHandlers['CheckCompleted'];
      const handlerPromise = handler({ payload: checkCompletedPayload });
      await jest.runAllTimersAsync();
      await handlerPromise;

      expect(mockCommentManager.updateOrCreateComment).toHaveBeenCalledTimes(1);

      const postedBody = mockCommentManager.updateOrCreateComment.mock.calls[0][3];

      // The section body should contain the text from output.text
      // This WILL FAIL because extractTextFromJson(undefined) returns undefined
      // and the frontend does not check ev.result.output as a fallback
      expect(postedBody).toContain('Here is my analysis');
    });
  });

  // ---------------------------------------------------------------------------
  // Test 4: End-to-end flow through level-dispatch renderTemplateContent
  // → CheckCompleted → GitHubFrontend → comment body
  // This tests the exact production scenario where the AI provider returns
  // the output object, the engine renders the template, and the frontend
  // posts the comment.
  // ---------------------------------------------------------------------------
  describe('Full pipeline: AI output → template render → frontend → comment', () => {
    it('should produce non-empty comment when issue-assistant AI check completes', async () => {
      // Step 1: AI provider returns ReviewSummary with output
      const aiResult: ReviewSummary & { output?: unknown } = {
        issues: [],
        output: {
          text: 'Here is my analysis of the security concern.\n\n## Path Traversal\n\nThe `path.Join` call does not sanitise user-supplied segments.',
          intent: 'comment_reply',
        },
      };

      // Step 2: Engine renders template
      const checkConfig = { schema: 'issue-assistant' };
      const renderedContent = await renderTemplateContent(
        'comment-assistant',
        checkConfig,
        aiResult as any
      );

      // Step 3: Engine builds CheckCompleted event (as in execution-invoker.ts:973-982)
      const eventContent = renderedContent || (aiResult as any).content;

      // Step 4: Frontend extracts content (as in github-frontend.ts:136-137)
      const rawContent = eventContent; // ev.result.content
      const extractedContent = extractTextFromJson(rawContent);

      // Step 5: Frontend stores extractedContent as section content
      // and renders it in the comment body

      // ASSERTION: The content flowing through the pipeline must be non-empty
      // If renderedContent is empty/undefined, the comment will be empty
      expect(renderedContent).toBeDefined();
      expect(renderedContent!.trim().length).toBeGreaterThan(0);
      expect(extractedContent).toBeDefined();
      expect(extractedContent!.length).toBeGreaterThan(0);
      expect(extractedContent).toContain('Here is my analysis');
    });

    it('comment is EMPTY when renderedContent is undefined and output has text (BUG)', async () => {
      // This simulates the production bug: template rendering returns undefined
      // (e.g., template file not found in production bundle path)
      // and the fallback `(result as any).content` is also undefined
      // because ReviewSummary from AI provider has no `content` field.

      const aiResult: ReviewSummary & { output?: unknown } = {
        issues: [],
        output: {
          text: 'Here is my analysis...',
          intent: 'comment_reply',
        },
      };

      // Simulate template rendering failure (returns undefined)
      const renderedContent: string | undefined = undefined;

      // Engine builds CheckCompleted event:
      // content: renderedContent || (result as any).content
      // Both are undefined, so content = undefined
      const eventContent = renderedContent || (aiResult as any).content;

      // Frontend extracts:
      const rawContent = eventContent;
      const extractedContent = extractTextFromJson(rawContent);

      // Frontend stores as section content:
      const sectionBody =
        extractedContent && extractedContent.toString().trim().length > 0
          ? extractedContent.toString().trim()
          : '';

      // BUG: sectionBody is empty even though output.text has content!
      // The frontend currently only looks at ev.result.content,
      // and does NOT fall back to ev.result.output.text
      expect(sectionBody).toBe(''); // This proves the bug exists

      // What it SHOULD be:
      // The frontend should fall back to extracting text from output
      // when content is empty/undefined
      expect(aiResult.output).toBeDefined();
      expect((aiResult.output as any).text).toContain('Here is my analysis');
    });

    it('extractTextFromJson on ev.result.content is the ONLY source for section body', () => {
      // Verify that GitHubFrontend ONLY uses ev.result.content for section content
      // and does NOT look at ev.result.output — this is the root cause

      // In github-frontend.ts CheckCompleted handler (lines 136-143):
      //   const rawContent = (ev?.result as any)?.content;          // ONLY content
      //   const extractedContent = extractTextFromJson(rawContent);
      //   this.upsertSectionState(group, ev.checkId, { content: extractedContent });
      //
      // When content is undefined, extractedContent is undefined,
      // and the section body is empty.
      //
      // The fix should either:
      // a) Ensure renderTemplateContent always succeeds (fix template path), OR
      // b) Add fallback: if content is empty, try extractTextFromJson(ev.result.output)

      const rawContent = undefined;
      const extractedContent = extractTextFromJson(rawContent);
      expect(extractedContent).toBeUndefined();

      // But the output HAS text:
      const output = { text: 'Analysis text here', intent: 'comment_reply' };
      const fallbackContent = extractTextFromJson(output);
      expect(fallbackContent).toBe('Analysis text here');
    });
  });
});
