import { GitHubFrontend } from '../../src/frontends/github-frontend';
import type { FrontendContext } from '../../src/frontends/host';

describe('GitHubFrontend Concurrency', () => {
  let frontend: GitHubFrontend;
  let mockContext: FrontendContext;
  let mockComments: any;
  let updateCalls: Array<{ group: string; timestamp: number }> = [];

  beforeEach(() => {
    updateCalls = [];

    // Mock CommentManager
    mockComments = {
      findVisorComment: jest.fn().mockResolvedValue(null),
      updateOrCreateComment: jest
        .fn()
        .mockImplementation(async (owner: string, repo: string, pr: number, body: string) => {
          // Record timestamp when update actually starts
          const callTime = Date.now();
          // Simulate network delay
          await new Promise(resolve => setTimeout(resolve, 50));
          updateCalls.push({
            group: 'test-group',
            timestamp: callTime,
          });
          return {
            id: 1,
            body,
            user: { login: 'bot' },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }),
    };

    mockContext = {
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
        runId: 'test-run',
        workflowId: 'test-workflow',
        repo: { owner: 'test-owner', name: 'test-repo' },
        pr: 123,
        headSha: 'abc123',
      },
      config: {
        output: {
          pr_comment: {
            enabled: true,
          },
        },
      },
    } as any;

    frontend = new GitHubFrontend();
    // Use a short delay for tests to run quickly
    frontend.minUpdateDelayMs = 100;
  });

  it('should serialize concurrent updates to the same group', async () => {
    // Access private method via reflection for testing
    const updateMethod = (frontend as any).updateGroupedComment.bind(frontend);

    const startTime = Date.now();

    // Simulate concurrent updates
    const updates = [
      updateMethod(mockContext, mockComments, 'test-group'),
      updateMethod(mockContext, mockComments, 'test-group'),
      updateMethod(mockContext, mockComments, 'test-group'),
    ];

    await Promise.all(updates);

    const totalTime = Date.now() - startTime;

    // All 3 updates should have been called
    expect(mockComments.updateOrCreateComment).toHaveBeenCalledTimes(3);

    // Verify they were serialized
    // With minUpdateDelayMs=100ms:
    // update1 (50ms) + delay(50ms) + update2 (50ms) + delay(50ms) + update3 (50ms) = ~250ms
    // If they ran concurrently it would be ~50ms
    expect(totalTime).toBeGreaterThan(150);

    // Also verify timestamps show serialization
    expect(updateCalls.length).toBe(3);

    // Verify the calls happened in sequence (allow for some to be close if queued)
    // At minimum, the total should span more time than a single call
    const totalSpan = updateCalls[updateCalls.length - 1].timestamp - updateCalls[0].timestamp;
    expect(totalSpan).toBeGreaterThanOrEqual(50); // At least one delay happened
  });

  it('should allow concurrent updates to different groups', async () => {
    const updateMethod = (frontend as any).updateGroupedComment.bind(frontend);

    const startTime = Date.now();

    // Simulate concurrent updates to different groups
    await Promise.all([
      updateMethod(mockContext, mockComments, 'group-1'),
      updateMethod(mockContext, mockComments, 'group-2'),
    ]);

    const totalTime = Date.now() - startTime;

    // Both updates should have been called
    expect(mockComments.updateOrCreateComment).toHaveBeenCalledTimes(2);

    // Different groups can run concurrently, so total time should be ~100ms (one network delay)
    // not ~200ms (two sequential delays) or ~2000ms (with serialization)
    // Allow some overhead, so check it's less than 500ms
    expect(totalTime).toBeLessThan(500);
  });

  it('should enforce minimum delay between updates', async () => {
    const updateMethod = (frontend as any).updateGroupedComment.bind(frontend);

    const startTime = Date.now();

    // Sequential updates should respect minUpdateDelayMs
    await updateMethod(mockContext, mockComments, 'test-group');
    const firstUpdateTime = Date.now() - startTime;

    await updateMethod(mockContext, mockComments, 'test-group');
    const secondUpdateTime = Date.now() - startTime;

    const timeBetweenUpdates = secondUpdateTime - firstUpdateTime;

    // Second update should wait at least 100ms (minUpdateDelayMs) after first completes
    expect(timeBetweenUpdates).toBeGreaterThanOrEqual(90); // Allow some variance
  });
});
