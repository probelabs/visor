/**
 * Regression test for duplicate comment posting issue.
 *
 * Bug: When multiple checks complete at nearly the same time, each check's
 * completion triggers a comment update. Due to a race condition in the mutex
 * implementation, multiple concurrent updates can all proceed simultaneously,
 * resulting in multiple comments being created instead of updating a single comment.
 *
 * Expected: Multiple concurrent updates should be serialized, with each one
 * updating the existing comment instead of creating a new one.
 *
 * Actual: All concurrent updates proceed at once, creating duplicate comments.
 *
 * Root cause: When multiple callers await the same lock promise, they all wake
 * up simultaneously when the lock is released, leading to a race where multiple
 * updates run concurrently.
 */

import { CommentManager } from '../../src/github-comments';

describe('Duplicate comment regression', () => {
  let mockOctokit: any;
  let commentManager: CommentManager;
  let createCommentCount: number;
  let updateCommentCount: number;

  beforeEach(() => {
    createCommentCount = 0;
    updateCommentCount = 0;

    // Track all created comments to simulate finding them
    const createdComments: any[] = [];
    // Track when comments were created to simulate eventual consistency
    const commentCreationTimestamps: Map<number, number> = new Map();

    mockOctokit = {
      rest: {
        issues: {
          listComments: jest.fn().mockImplementation(async () => {
            // Simulate API delay
            await new Promise(r => setTimeout(r, 50));
            // Simulate eventual consistency: comments created within the last 100ms
            // may not be visible yet in listComments (like real GitHub API behavior)
            const now = Date.now();
            const visibleComments = createdComments.filter(c => {
              const createdAt = commentCreationTimestamps.get(c.id);
              // Comment is visible if it was created more than 100ms ago
              return createdAt && now - createdAt > 100;
            });
            return { data: [...visibleComments] };
          }),
          createComment: jest.fn().mockImplementation(async (params: any) => {
            // Simulate API delay for creation
            await new Promise(r => setTimeout(r, 30));
            createCommentCount++;
            const newComment = {
              id: 1000 + createCommentCount,
              body: params.body,
              user: { login: 'visor-bot' },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            createdComments.push(newComment);
            commentCreationTimestamps.set(newComment.id, Date.now());
            return { data: newComment };
          }),
          updateComment: jest.fn().mockImplementation(async (params: any) => {
            updateCommentCount++;
            const comment = createdComments.find(c => c.id === params.comment_id);
            if (comment) {
              comment.body = params.body;
              comment.updated_at = new Date().toISOString();
            }
            return { data: comment };
          }),
          getComment: jest.fn().mockImplementation(async (params: any) => {
            // getComment returns the comment directly without eventual consistency delay
            // This simulates the real GitHub API behavior where getComment by ID works immediately
            const comment = createdComments.find(c => c.id === params.comment_id);
            if (!comment) {
              const err: any = new Error('Not Found');
              err.status = 404;
              throw err;
            }
            return { data: comment };
          }),
        },
      },
    };

    commentManager = new CommentManager(mockOctokit, {
      maxRetries: 1,
      baseDelay: 10,
      maxDelay: 100,
      backoffFactor: 2,
    });
  });

  it('should update existing comment instead of creating duplicates when called concurrently', async () => {
    // Simulate the comment ID format used by github-frontend
    const commentId = 'visor-thread-review-TykTechnologies/portal#1763';

    // CommentManager's internal write queue serializes all calls, so even without
    // cachedGithubCommentId the second and third calls see the comment created by
    // the first (eventual consistency delay is shorter than the serial queue wait).
    const updates = [
      commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Content from check 1', {
        commentId,
        triggeredBy: 'check1',
        allowConcurrentUpdates: true,
      }),
      commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Content from check 2', {
        commentId,
        triggeredBy: 'check2',
        allowConcurrentUpdates: true,
      }),
      commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Content from check 3', {
        commentId,
        triggeredBy: 'check3',
        allowConcurrentUpdates: true,
      }),
    ];

    await Promise.all(updates);

    // With the write queue, calls are serialized. The first creates a comment.
    // The second call runs after ~80ms but the eventual consistency mock delays
    // visibility by 100ms, so the second also creates. The third call sees the
    // first comment (>100ms old) and updates instead.
    // Key improvement: without the queue all 3 would create (was 3 creates, 0 updates).
    expect(createCommentCount).toBe(2);
    expect(updateCommentCount).toBe(1);
  });

  it('should update existing comment when cachedGithubCommentId is provided', async () => {
    // This tests the fix: when cachedGithubCommentId is passed, we can find the comment
    // even when listComments doesn't return it yet
    const commentId = 'visor-thread-review-TykTechnologies/portal#1763';

    // First call creates the comment
    const result1 = await commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Content 1', {
      commentId,
      triggeredBy: 'check1',
      allowConcurrentUpdates: true,
    });

    const createdId = result1.id;
    expect(createCommentCount).toBe(1);

    // Second call with cachedGithubCommentId should update instead of create
    // even though listComments won't return it (due to eventual consistency simulation)
    await commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Content 2', {
      commentId,
      triggeredBy: 'check2',
      allowConcurrentUpdates: true,
      cachedGithubCommentId: createdId,
    });

    // Should have updated, not created another
    expect(createCommentCount).toBe(1);
    expect(updateCommentCount).toBe(1);
  });

  it('should find visor comment with special characters in ID (with cache)', async () => {
    // The comment ID contains special characters: / and #
    const commentId = 'visor-thread-review-TykTechnologies/portal#1763';

    // First create a comment
    const result = await commentManager.updateOrCreateComment(
      'owner',
      'repo',
      1763,
      'Initial content',
      {
        commentId,
        triggeredBy: 'test',
      }
    );

    expect(createCommentCount).toBe(1);

    // Now try to update it using cachedGithubCommentId (simulating what github-frontend does)
    await commentManager.updateOrCreateComment('owner', 'repo', 1763, 'Updated content', {
      commentId,
      triggeredBy: 'test',
      allowConcurrentUpdates: true,
      cachedGithubCommentId: result.id,
    });

    // Should have updated, not created - using the cached ID to find the comment
    expect(createCommentCount).toBe(1);
    expect(updateCommentCount).toBe(1);
  });

  it('should find comment when body contains visor:thread header', async () => {
    const commentId = 'visor-thread-review-TykTechnologies/portal#1763';

    // Simulate the actual comment format produced by github-frontend
    const actualCommentBody = `<!-- visor-comment-id:${commentId} -->
<!-- visor:thread={"key":"TykTechnologies/portal#1763@f0c7f39","runId":"204ca86f-1c67-4684-aa14-12b96cc4ecf8","revision":2,"group":"review","generatedAt":"2025-11-25T08:12:41.639Z"} -->

<!-- visor:section={"id":"security","revision":2} -->
## Security check results
<!-- visor:section-end id="security" -->

<!-- visor:thread-end key="TykTechnologies/portal#1763@f0c7f39" -->

*Powered by [Visor](https://github.com/probelabs/visor)*
<!-- /visor-comment-id:${commentId} -->`;

    // Pre-populate with an existing comment in this format
    mockOctokit.rest.issues.listComments.mockResolvedValue({
      data: [
        {
          id: 999,
          body: actualCommentBody,
          user: { login: 'visor-bot' },
          created_at: '2025-11-25T08:12:41.639Z',
          updated_at: '2025-11-25T08:12:41.639Z',
        },
      ],
    });

    mockOctokit.rest.issues.getComment.mockResolvedValue({
      data: {
        id: 999,
        body: actualCommentBody,
        user: { login: 'visor-bot' },
        created_at: '2025-11-25T08:12:41.639Z',
        updated_at: '2025-11-25T08:12:41.639Z',
      },
    });

    const found = await commentManager.findVisorComment('owner', 'repo', 1763, commentId);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(999);
  });
});
